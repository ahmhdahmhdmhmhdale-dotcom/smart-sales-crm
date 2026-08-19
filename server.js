require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const FRONTEND = path.join(ROOT, 'frontend');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(ROOT, 'public', 'uploads');

const FILES = {
  settings: 'settings.json',
  customers: 'customers.json',
  messages: 'messages.json',
  orders: 'orders.json',
  employees: 'employees.json',
  managers: 'managers.json'
};

const DEFAULTS = {
  settings: {
    companyName: 'Creative Kids',
    businessType: 'المبيعات وخدمة العملاء',
    logoUrl: '',
    primaryColor: '#6366f1',
    currency: 'EGP',
    tax: 0,
    shipping: 0,
    pageId: process.env.META_PAGE_ID || '',
    pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || '',
    verifyToken: process.env.META_VERIFY_TOKEN || 'creative_kids_2026',
    appSecret: process.env.META_APP_SECRET || '',
    graphVersion: process.env.META_GRAPH_VERSION || 'v26.0',
    instagramAccountId: process.env.INSTAGRAM_ACCOUNT_ID || '',
    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    whatsappEnabled: false,
    autoReplyEnabled: true,
    quickReplies: [
      'أهلاً وسهلاً ❤️ كيف يمكننا مساعدتك؟',
      'ابعتلنا اسم المنتج ونرسل لك السعر والتفاصيل.',
      'ابعتلنا المحافظة لمعرفة تكلفة الشحن ومدة التوصيل.',
      'تمام ❤️ ابعتلنا الاسم والعنوان ورقم الهاتف لتأكيد الطلب.'
    ]
  },
  customers: [],
  messages: [],
  orders: [],
  employees: [],
  managers: []
};

for (const dir of [DATA, UPLOADS]) fs.mkdirSync(dir, { recursive: true });

function dataFile(name) {
  if (!FILES[name]) throw new Error(`Unknown data file: ${name}`);
  return path.join(DATA, FILES[name]);
}

function readData(name) {
  const fallback = DEFAULTS[name];
  try {
    const raw = fs.readFileSync(dataFile(name), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || parsed === undefined) throw new Error('empty');
    return parsed;
  } catch {
    const value = JSON.parse(JSON.stringify(fallback));
    writeData(name, value);
    return value;
  }
}

function writeData(name, value) {
  const target = dataFile(name);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, target);
}

function ensureDataFiles() {
  for (const key of Object.keys(FILES)) {
    if (!fs.existsSync(dataFile(key))) writeData(key, DEFAULTS[key]);
  }
}
ensureDataFiles();
ensureEmployeeStore();

function getSettings() {
  const s = { ...DEFAULTS.settings, ...readData('settings') };
  return {
    ...s,
    pageId: s.pageId || process.env.META_PAGE_ID || '',
    pageAccessToken: s.pageAccessToken || process.env.META_PAGE_ACCESS_TOKEN || '',
    verifyToken: s.verifyToken || process.env.META_VERIFY_TOKEN || DEFAULTS.settings.verifyToken,
    appSecret: s.appSecret || process.env.META_APP_SECRET || '',
    graphVersion: s.graphVersion || process.env.META_GRAPH_VERSION || DEFAULTS.settings.graphVersion
  };
}

function publicSettings() {
  const s = getSettings();
  return {
    ...s,
    pageAccessToken: s.pageAccessToken ? '••••••••••••••••' : '',
    appSecret: s.appSecret ? '••••••••••••••••' : '',
    whatsappAccessToken: s.whatsappAccessToken ? '••••••••••••••••' : ''
  };
}

function sanitizeUser(user) {
  if (!user) return user;
  const { password, passwordHash, ...safe } = user;
  return safe;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!String(stored).startsWith('scrypt:')) return String(stored) === String(password);
  const [, salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function syncManagerAccount(employee, previousRole = employee.role) {
  let managers = readData('managers');
  const username = String(employee.username || '').trim().toLowerCase();
  const index = managers.findIndex(x => String(x.username || '').trim().toLowerCase() === username);
  const isManager = employee.role === 'مدير' || employee.isPrimaryManager;
  if (isManager) {
    const account = {
      username: employee.username,
      name: employee.name,
      ...(employee.passwordHash ? { passwordHash: employee.passwordHash } : employee.password !== undefined ? { password: employee.password } : {})
    };
    if (index >= 0) managers[index] = { ...managers[index], ...account };
    else managers.push(account);
  } else if (previousRole === 'مدير' && index >= 0 && !employee.isPrimaryManager) {
    managers.splice(index, 1);
  }
  writeData('managers', managers);
}

function normalizeEmployee(employee) {
  return {
    id: employee.id || id(),
    name: String(employee.name || '').trim(),
    username: String(employee.username || '').trim().toLowerCase(),
    role: employee.role || 'موظف مبيعات',
    status: employee.status || 'نشط',
    createdAt: employee.createdAt || new Date().toISOString(),
    shift: employee.shift || '',
    orders: Number(employee.orders || 0),
    sales: Number(employee.sales || 0),
    avg: employee.avg || '-',
    ...(employee.isPrimaryManager ? { isPrimaryManager: true } : {}),
    ...(employee.passwordHash ? { passwordHash: employee.passwordHash } : employee.password !== undefined ? { password: employee.password } : {})
  };
}

function ensureEmployeeStore() {
  let employees = readData('employees');
  if (!Array.isArray(employees)) employees = [];
  employees = employees.map(normalizeEmployee);
  const primary = employees.find(x => x.isPrimaryManager || x.username === 'admin');
  if (!primary) {
    employees.unshift(normalizeEmployee({
      id: 'primary-manager',
      name: 'المدير الرئيسي',
      username: 'admin',
      password: 'Admin@2026',
      role: 'مدير',
      status: 'نشط',
      isPrimaryManager: true
    }));
  } else {
    primary.isPrimaryManager = true;
    primary.role = 'مدير';
    primary.status = primary.status || 'نشط';
  }
  writeData('employees', employees);
}

function id() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

app.disable('x-powered-by');

// Lightweight health endpoint used by the Windows launcher to wait until Express is ready.
app.get('/api/health', (_, res) => res.json({ ok: true, service: 'creative-kids-crm', time: new Date().toISOString() }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS));
app.use(express.static(FRONTEND));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_, file, cb) => {
      const safe = String(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    cb(null, /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype));
  }
});

// ---------- Authentication ----------
function findLoginUser(collection, username) {
  const normalized = String(username || '').trim().toLowerCase();
  return readData(collection).find(x => String(x.username || '').trim().toLowerCase() === normalized);
}

app.post('/api/login', (req, res) => {
  const { role, username, password } = req.body || {};
  const collection = role === 'manager' ? 'managers' : 'employees';
  const user = findLoginUser(collection, username);
  if (!user || !verifyPassword(password, user.passwordHash || user.password)) {
    return res.status(401).json({ ok: false, error: 'بيانات الدخول غير صحيحة' });
  }
  if (collection === 'employees' && user.status && user.status !== 'نشط') {
    return res.status(403).json({ ok: false, error: 'هذا الحساب غير نشط حالياً' });
  }
  // Migrate legacy plaintext employee passwords on successful login.
  if (collection === 'employees' && user.password && !user.passwordHash) {
    user.passwordHash = hashPassword(user.password);
    delete user.password;
    const users = readData(collection);
    const index = users.findIndex(x => String(x.id) === String(user.id));
    if (index >= 0) { users[index] = user; writeData(collection, users); }
  }
  res.json({ ok: true, user: sanitizeUser(user) });
});

app.post('/api/change-password', (req, res) => {
  const { role, username, currentPassword, newPassword } = req.body || {};
  if (!role || !username || !currentPassword || !newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ ok: false, error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
  }
  const collection = role === 'manager' ? 'managers' : 'employees';
  const users = readData(collection);
  const user = users.find(x => String(x.username || '').toLowerCase() === String(username).trim().toLowerCase());
  if (!user || !verifyPassword(currentPassword, user.passwordHash || user.password)) {
    return res.status(401).json({ ok: false, error: 'كلمة المرور الحالية غير صحيحة' });
  }
  user.passwordHash = hashPassword(newPassword);
  delete user.password;
  writeData(collection, users);
  res.json({ ok: true });
});

// ---------- Settings ----------
app.get('/api/settings', (_, res) => res.json(publicSettings()));

app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const current = getSettings();
  const next = { ...current };

  const strings = [
    'companyName', 'businessType', 'logoUrl', 'primaryColor', 'currency',
    'pageId', 'verifyToken', 'graphVersion', 'instagramAccountId',
    'whatsappPhoneNumberId', 'whatsappBusinessAccountId'
  ];
  for (const key of strings) {
    if (body[key] !== undefined) next[key] = String(body[key]).trim();
  }

  if (body.pageAccessToken && !String(body.pageAccessToken).includes('••••')) {
    next.pageAccessToken = String(body.pageAccessToken).trim();
  }
  if (body.appSecret && !String(body.appSecret).includes('••••')) {
    next.appSecret = String(body.appSecret).trim();
  }
  if (body.whatsappAccessToken && !String(body.whatsappAccessToken).includes('••••')) {
    next.whatsappAccessToken = String(body.whatsappAccessToken).trim();
  }
  if (body.tax !== undefined) next.tax = Number(body.tax) || 0;
  if (body.shipping !== undefined) next.shipping = Number(body.shipping) || 0;
  if (body.whatsappEnabled !== undefined) next.whatsappEnabled = Boolean(body.whatsappEnabled);
  if (body.autoReplyEnabled !== undefined) next.autoReplyEnabled = Boolean(body.autoReplyEnabled);
  if (Array.isArray(body.quickReplies)) {
    next.quickReplies = body.quickReplies.map(String).map(x => x.trim()).filter(Boolean).slice(0, 20);
  }

  if (!/^#[0-9a-f]{6}$/i.test(next.primaryColor)) {
    return res.status(400).json({ ok: false, error: 'لون النظام غير صالح' });
  }

  writeData('settings', next);
  res.json({ ok: true, settings: publicSettings() });
});

app.post('/api/settings/logo', upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'يرجى اختيار صورة PNG/JPG/WEBP/GIF صالحة' });
  const s = getSettings();
  s.logoUrl = `/uploads/${req.file.filename}`;
  writeData('settings', s);
  res.json({ ok: true, logoUrl: s.logoUrl });
});

async function graphRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Meta API returned HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

app.post('/api/settings/test-connection', async (req, res) => {
  const channel = String(req.body?.channel || 'messenger').toLowerCase();
  const s = getSettings();
  try {
    if (channel === 'whatsapp') {
      if (!s.whatsappAccessToken || !s.whatsappPhoneNumberId) {
        throw new Error('بيانات WhatsApp Phone Number ID وAccess Token غير مكتملة');
      }
      const url = `https://graph.facebook.com/${encodeURIComponent(s.graphVersion)}/${encodeURIComponent(s.whatsappPhoneNumberId)}?fields=id,display_phone_number,verified_name&access_token=${encodeURIComponent(s.whatsappAccessToken)}`;
      const data = await graphRequest(url);
      return res.json({ ok: true, channel: 'whatsapp', data });
    }

    if (!s.pageAccessToken || !s.pageId) {
      throw new Error('Page ID وPage Access Token غير مكتملين');
    }
    const url = `https://graph.facebook.com/${encodeURIComponent(s.graphVersion)}/${encodeURIComponent(s.pageId)}?fields=id,name&access_token=${encodeURIComponent(s.pageAccessToken)}`;
    const data = await graphRequest(url);
    res.json({ ok: true, channel: 'messenger', data });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message,
      details: error.body?.error ? {
        type: error.body.error.type,
        code: error.body.error.code
      } : undefined
    });
  }
});

app.get('/api/status', (_, res) => {
  const s = getSettings();
  res.json({
    ok: true,
    companyName: s.companyName,
    pageId: s.pageId,
    graphVersion: s.graphVersion,
    pageAccessTokenConfigured: Boolean(s.pageAccessToken),
    instagramAccountConfigured: Boolean(s.instagramAccountId),
    whatsappConfigured: Boolean(s.whatsappPhoneNumberId && s.whatsappAccessToken),
    whatsappEnabled: Boolean(s.whatsappEnabled),
    autoReplyEnabled: Boolean(s.autoReplyEnabled),
    webhook: '/webhook'
  });
});

// ---------- Generic REST resources ----------
function resourceRoutes(name, options = {}) {
  app.get(`/api/${name}`, (req, res) => {
    let rows = readData(name);
    if (req.query.search) {
      const q = String(req.query.search).toLowerCase();
      rows = rows.filter(row => JSON.stringify(row).toLowerCase().includes(q));
    }
    if (req.query.limit) rows = rows.slice(0, Math.min(Number(req.query.limit) || 100, 1000));
    res.json(rows);
  });

  app.get(`/api/${name}/:id`, (req, res) => {
    const row = readData(name).find(x => String(x.id) === String(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'العنصر غير موجود' });
    res.json(row);
  });

  app.post(`/api/${name}`, (req, res) => {
    const rows = readData(name);
    const body = req.body || {};
    const row = { id: body.id || id(), createdAt: body.createdAt || new Date().toISOString(), ...body };
    rows.unshift(row);
    writeData(name, rows);
    res.status(201).json(row);
  });

  app.patch(`/api/${name}/:id`, (req, res) => {
    const rows = readData(name);
    const index = rows.findIndex(x => String(x.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ ok: false, error: 'العنصر غير موجود' });
    rows[index] = { ...rows[index], ...(req.body || {}), id: rows[index].id, updatedAt: new Date().toISOString() };
    writeData(name, rows);
    res.json(rows[index]);
  });

  app.delete(`/api/${name}/:id`, (req, res) => {
    const rows = readData(name);
    const index = rows.findIndex(x => String(x.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ ok: false, error: 'العنصر غير موجود' });
    const [deleted] = rows.splice(index, 1);
    writeData(name, rows);
    res.json({ ok: true, deleted });
  });
}

resourceRoutes('customers');
resourceRoutes('orders');

// Messages need read/unread handling and outbound sending, but also expose full REST CRUD.
resourceRoutes('messages');

// ---------- Staff & User Management ----------
app.get('/api/employees', (_, res) => {
  ensureEmployeeStore();
  res.json(readData('employees').map(sanitizeUser));
});

app.post('/api/employees', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const role = String(body.role || 'موظف مبيعات').trim();
  const status = String(body.status || 'نشط').trim();
  const validRoles = ['مدير', 'موظف مبيعات', 'خدمة عملاء'];
  const validStatuses = ['نشط', 'غير نشط'];

  if (!name || !username || !password) return res.status(400).json({ ok: false, error: 'الاسم واسم المستخدم وكلمة المرور مطلوبة' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  if (!/^[^\s@]+(?:@[^\s@]+)?$/.test(username)) return res.status(400).json({ ok: false, error: 'اسم المستخدم غير صالح' });
  if (!validRoles.includes(role)) return res.status(400).json({ ok: false, error: 'الدور الوظيفي غير صالح' });
  if (!validStatuses.includes(status)) return res.status(400).json({ ok: false, error: 'حالة الحساب غير صالحة' });

  const employees = readData('employees');
  const managers = readData('managers');
  const duplicate = [...employees, ...managers].some(x => String(x.username || '').trim().toLowerCase() === username);
  if (duplicate) return res.status(409).json({ ok: false, error: 'اسم المستخدم مستخدم بالفعل' });

  const employee = normalizeEmployee({
    id: id(), name, username, role, status, createdAt: new Date().toISOString(),
    passwordHash: hashPassword(password), orders: 0, sales: 0, avg: '-'
  });
  delete employee.password;
  employees.unshift(employee);
  writeData('employees', employees);
  if (employee.role === 'مدير') syncManagerAccount(employee);
  res.status(201).json({ ok: true, employee: sanitizeUser(employee) });
});

app.put('/api/employees/:id', (req, res) => {
  const employees = readData('employees');
  const index = employees.findIndex(x => String(x.id) === String(req.params.id));
  if (index < 0) return res.status(404).json({ ok: false, error: 'الموظف غير موجود' });
  const employee = employees[index];
  const previousRole = employee.role;
  const body = req.body || {};
  const validRoles = ['مدير', 'موظف مبيعات', 'خدمة عملاء'];
  const validStatuses = ['نشط', 'غير نشط'];

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return res.status(400).json({ ok: false, error: 'الاسم لا يمكن أن يكون فارغاً' });
    employee.name = name;
  }
  if (body.role !== undefined) {
    if (!validRoles.includes(String(body.role))) return res.status(400).json({ ok: false, error: 'الدور الوظيفي غير صالح' });
    employee.role = String(body.role);
  }
  if (body.status !== undefined) {
    if (!validStatuses.includes(String(body.status))) return res.status(400).json({ ok: false, error: 'حالة الحساب غير صالحة' });
    employee.status = String(body.status);
  }
  if (employee.isPrimaryManager) {
    employee.role = 'مدير';
    employee.status = 'نشط';
  }
  employee.updatedAt = new Date().toISOString();
  employees[index] = employee;
  writeData('employees', employees);
  syncManagerAccount(employee, previousRole);
  res.json({ ok: true, employee: sanitizeUser(employee) });
});

app.put('/api/employees/:id/password', (req, res) => {
  const employees = readData('employees');
  const index = employees.findIndex(x => String(x.id) === String(req.params.id));
  if (index < 0) return res.status(404).json({ ok: false, error: 'الموظف غير موجود' });
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  employees[index].passwordHash = hashPassword(password);
  delete employees[index].password;
  employees[index].updatedAt = new Date().toISOString();
  writeData('employees', employees);
  if (employees[index].role === 'مدير' || employees[index].isPrimaryManager) syncManagerAccount(employees[index]);
  res.json({ ok: true, employee: sanitizeUser(employees[index]) });
});

app.delete('/api/employees/:id', (req, res) => {
  const employees = readData('employees');
  const index = employees.findIndex(x => String(x.id) === String(req.params.id));
  if (index < 0) return res.status(404).json({ ok: false, error: 'الموظف غير موجود' });
  if (employees[index].isPrimaryManager || String(employees[index].username).toLowerCase() === 'admin') {
    return res.status(403).json({ ok: false, error: 'لا يمكن حذف حساب المدير الرئيسي' });
  }
  const [deleted] = employees.splice(index, 1);
  writeData('employees', employees);
  if (deleted.role === 'مدير') {
    const managers = readData('managers').filter(x => String(x.username || '').trim().toLowerCase() !== String(deleted.username || '').trim().toLowerCase());
    writeData('managers', managers);
  }
  res.json({ ok: true, deleted: sanitizeUser(deleted) });
});

app.get('/api/managers', (_, res) => res.json(readData('managers').map(sanitizeUser)));

app.post('/api/messages/:id/read', (req, res) => {
  const rows = readData('messages');
  const message = rows.find(x => String(x.id) === String(req.params.id));
  if (!message) return res.status(404).json({ ok: false, error: 'الرسالة غير موجودة' });
  message.unread = false;
  writeData('messages', rows);
  res.json({ ok: true, message });
});

function findCustomer(channel, senderId, name) {
  const customers = readData('customers');
  const key = `${channel}:${senderId}`;
  let customer = customers.find(x => x.key === key);
  if (!customer) {
    customer = {
      id: id(),
      key,
      externalId: senderId,
      name: name || `${channel} Customer`,
      channel,
      status: 'لم يطلب',
      last: new Date().toISOString(),
      messages: 0,
      unread: 0
    };
    customers.unshift(customer);
  }
  customer.last = new Date().toISOString();
  customer.messages = (customer.messages || 0) + 1;
  customer.unread = (customer.unread || 0) + 1;
  writeData('customers', customers);
  return customer;
}

function appendMessage(message) {
  const rows = readData('messages');
  rows.unshift({ id: message.id || id(), time: new Date().toISOString(), ...message });
  writeData('messages', rows.slice(0, 5000));
}

async function sendMessengerReply(recipientId, text) {
  const s = getSettings();
  if (!s.pageAccessToken) throw new Error('Page Access Token غير مضبوط');
  return graphRequest(
    `https://graph.facebook.com/${s.graphVersion}/me/messages?access_token=${encodeURIComponent(s.pageAccessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } })
    }
  );
}

async function sendInstagramReply(recipientId, text) {
  const s = getSettings();
  if (!s.pageAccessToken || !s.instagramAccountId) throw new Error('بيانات Instagram/Page غير مكتملة');
  return graphRequest(
    `https://graph.facebook.com/${s.graphVersion}/${encodeURIComponent(s.instagramAccountId)}/messages?access_token=${encodeURIComponent(s.pageAccessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } })
    }
  );
}

async function sendWhatsAppReply(recipientId, text) {
  const s = getSettings();
  if (!s.whatsappAccessToken || !s.whatsappPhoneNumberId) throw new Error('بيانات WhatsApp غير مكتملة');
  return graphRequest(
    `https://graph.facebook.com/${s.graphVersion}/${encodeURIComponent(s.whatsappPhoneNumberId)}/messages?access_token=${encodeURIComponent(s.whatsappAccessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipientId,
        type: 'text',
        text: { body: text }
      })
    }
  );
}

async function sendReply(channel, recipientId, text) {
  if (channel === 'Instagram') return sendInstagramReply(recipientId, text);
  if (channel === 'WhatsApp') return sendWhatsAppReply(recipientId, text);
  return sendMessengerReply(recipientId, text);
}

app.post('/api/send-message', async (req, res) => {
  try {
    const { channel, recipientId, text, customerId } = req.body || {};
    if (!channel || !recipientId || !String(text || '').trim()) {
      return res.status(400).json({ ok: false, error: 'channel وrecipientId وtext مطلوبة' });
    }
    const cleanText = String(text).trim();
    const result = await sendReply(channel, String(recipientId), cleanText);
    appendMessage({
      customerId,
      externalUserId: String(recipientId),
      name: 'عميل',
      channel,
      text: cleanText,
      direction: 'outbound',
      unread: false,
      manual: true
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message, details: error.body?.error || null });
  }
});

// ---------- Webhooks ----------
function verifyMetaSignature(req) {
  const s = getSettings();
  if (!s.appSecret) return true;
  const signature = req.get('x-hub-signature-256');
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = crypto
    .createHmac('sha256', s.appSecret)
    .update(JSON.stringify(req.body))
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.slice(7)),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

app.get('/webhook', (req, res) => {
  const s = getSettings();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === s.verifyToken) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(403);
  if (!req.body?.entry) return res.sendStatus(404);

  // Acknowledge immediately; Meta retries if the endpoint is slow.
  res.sendStatus(200);
  for (const event of normalizeWebhookEvents(req.body)) {
    processIncomingEvent(event).catch(error => console.error('[Webhook]', error));
  }
});

function normalizeWebhookEvents(payload) {
  const events = [];
  const channel = payload.object === 'instagram'
    ? 'Instagram'
    : payload.object === 'whatsapp_business_account'
      ? 'WhatsApp'
      : 'Messenger';

  for (const entry of payload.entry || []) {
    if (channel === 'WhatsApp') {
      for (const change of entry.changes || []) {
        for (const msg of change.value?.messages || []) {
          if (!msg.from || msg.type !== 'text') continue;
          events.push({
            channel,
            senderId: String(msg.from),
            recipientId: String(entry.id || ''),
            text: msg.text?.body || '',
            timestamp: Number(msg.timestamp || 0) * 1000,
            mid: msg.id || null,
            profileName: change.value?.contacts?.find(c => c.wa_id === msg.from)?.profile?.name || 'WhatsApp Customer'
          });
        }
      }
      continue;
    }

    for (const event of entry.messaging || []) {
      if (!event.message || event.message.is_echo || !event.sender?.id) continue;
      const text = event.message.text || '';
      if (!text) continue;
      events.push({
        channel,
        senderId: String(event.sender.id),
        recipientId: String(event.recipient?.id || entry.id || ''),
        text,
        timestamp: event.timestamp || Date.now(),
        mid: event.message.mid || null
      });
    }
  }
  return events;
}

function autoReply(text, settings) {
  const t = String(text).trim().toLowerCase();
  if (/^(سلام|السلام|اهلا|أهلا|هاي|hello|hi|صباح الخير|مساء الخير)/i.test(t)) {
    return settings.quickReplies[0] || `أهلاً وسهلاً ❤️ معك خدمة عملاء ${settings.companyName}.`;
  }
  if (/سعر|الاسعار|الأسعار|بكام|بكم|price/i.test(t)) {
    return settings.quickReplies[1] || 'ابعتلنا اسم المنتج ونرسل لك السعر والتفاصيل.';
  }
  if (/الشحن|توصيل|delivery|shipping/i.test(t)) {
    return settings.quickReplies[2] || 'ابعتلنا المحافظة لمعرفة تكلفة الشحن ومدة التوصيل.';
  }
  if (/اطلب|طلب|order|buy/i.test(t)) {
    return settings.quickReplies[3] || 'تمام ❤️ ابعتلنا الاسم والعنوان ورقم الهاتف لتأكيد الطلب.';
  }
  return null;
}

async function processIncomingEvent(event) {
  const settings = getSettings();
  const customer = findCustomer(event.channel, event.senderId, event.profileName);
  appendMessage({
    externalMessageId: event.mid,
    customerId: customer.id,
    externalUserId: event.senderId,
    name: customer.name,
    channel: event.channel,
    text: event.text,
    direction: 'inbound',
    unread: true
  });

  if (!settings.autoReplyEnabled) return;
  const reply = autoReply(event.text, settings);
  if (!reply) return;

  try {
    await sendReply(event.channel, event.senderId, reply);
    appendMessage({
      customerId: customer.id,
      externalUserId: event.senderId,
      name: customer.name,
      channel: event.channel,
      text: reply,
      direction: 'outbound',
      unread: false,
      auto: true
    });
  } catch (error) {
    console.error('[Meta send]', error.body || error.message);
  }
}

// ---------- Excel export ----------
function parseDateValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function dayStart(value) {
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function dayEnd(value) {
  const d = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function getExportRange(q) {
  const period = String(q.period || 'all');
  const now = new Date();
  if (period === 'today') return [new Date(now.getFullYear(), now.getMonth(), now.getDate()), new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)];
  if (period === 'date' && q.date) {
    const a = dayStart(q.date), b = dayEnd(q.date);
    return a && b ? [a, b] : null;
  }
  if (period === 'range' && q.from && q.to) {
    const a = dayStart(q.from), b = dayEnd(q.to);
    return a && b ? [a, b] : null;
  }
  if (period === 'month') {
    if (!/^\d{4}-\d{2}$/.test(String(q.month || ''))) return null;
    const [y, m] = String(q.month).split('-').map(Number);
    return [new Date(y, m - 1, 1), new Date(y, m, 0, 23, 59, 59, 999)];
  }
  return null;
}
function filterRowsByDate(rows, key, range) {
  if (!range) return rows;
  return rows.filter(row => {
    const d = parseDateValue(row[key]);
    return d && d >= range[0] && d <= range[1];
  });
}
app.get('/api/export/excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const type = String(req.query.type || 'all');
    const range = getExportRange(req.query);
    if (['date', 'range', 'month'].includes(String(req.query.period || '')) && !range) {
      return res.status(400).json({ ok: false, error: 'نطاق التاريخ غير صالح' });
    }

    const employee = String(req.query.employee || '');
    const data = {
      customers: filterRowsByDate(readData('customers'), 'last', range),
      orders: filterRowsByDate(readData('orders'), 'date', range).filter(x => !employee || String(x.employee || '') === employee),
      messages: filterRowsByDate(readData('messages'), 'time', range).filter(x => !employee || String(x.employee || '') === employee),
      employees: readData('employees')
    };
    const selected = type === 'all' ? ['customers', 'orders', 'messages', 'employees'] : [type];
    const labels = { customers: 'العملاء', orders: 'الأوردرات', messages: 'المحادثات', employees: 'الموظفون' };
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'White-Label CRM';
    workbook.created = new Date();

    for (const key of selected) {
      if (!data[key]) continue;
      const rows = data[key];
      const sheet = workbook.addWorksheet(labels[key] || key);
      if (!rows.length) {
        sheet.addRow(['لا توجد بيانات ضمن الفترة المحددة']);
        continue;
      }
      const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
      sheet.columns = columns.map(keyName => ({
        header: keyName,
        key: keyName,
        width: Math.min(Math.max(String(keyName).length + 4, 14), 32)
      }));
      rows.forEach(row => sheet.addRow(columns.map(keyName => row[keyName] ?? '')));
      sheet.getRow(1).font = { bold: true };
      sheet.autoFilter = { from: 1, to: columns.length };
      sheet.views = [{ rightToLeft: true }];
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="crm-export-${stamp}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Clear business data only; users/settings remain intact.
app.post('/api/reset-demo', (_, res) => {
  writeData('customers', []);
  writeData('messages', []);
  writeData('orders', []);
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ ok: false, error: 'حدث خطأ داخلي في الخادم' });
});

app.listen(PORT, () => {
  console.log(`White-Label CRM running at http://localhost:${PORT}`);
});
