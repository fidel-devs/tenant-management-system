require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs'); 
const helmet = require('helmet');
const path = require('path');
const { Connection } = require('mysql2');

const app = express();
app.set('trust proxy', 1);
app.get('/health', (req, res) => res.send('ok'));
const PORT = Number(process.env.PORT || 3000);
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'renthome_db',
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined
});

function cleanImageUrls(list, single) {
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
  let arr = Array.isArray(list) ? list : [];
  if (!arr.length && single) arr = [single];
  const out = [];
  for (const raw of arr) {
    const u = String(raw || '').trim();
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) return { error: 'Every image link must start with http:// or https://' };
    if (u.length > 500) return { error: 'An image link is too long (500 characters at most).' };
    if (!out.includes(u)) out.push(u);
  }
  if (out.length > 8) return { error: 'You can add up to 8 images only.' };
  return { urls: out };
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  name: 'renthome.sid',
  store: new MySQLStore({}, pool),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));

/* =========================================================
   NEW: property edit/remove and rent payment verification.
   Registered BEFORE the older routes below, so the two routes it redefines
   (/api/landlord/summary and /api/tenant/overview, now returning image_url)
   are the ones that answer.
   ========================================================= */
(function addRentFeatures(app, db, options = {}) {
  const getUser = options.getUser || (req => req.user || (req.session && req.session.user) || null);
  const need = role => (req, res, next) => {
    const u = getUser(req);
    if (!u) return res.status(401).json({ error: 'Please log in.' });
    if (role && u.role !== role) return res.status(403).json({ error: 'You do not have access to this.' });
    req.me = u;
    next();
  };
  const audit = async (userId, action, details) => {
  try { await db.query('INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)', [userId, action, details]); } catch (e) {}
  };
  const notify = async (userId, type, message, paymentId) => {
  try { await db.query('INSERT INTO notifications (user_id, type, message, payment_id) VALUES (?,?,?,?)', [userId, type, String(message).slice(0, 255), paymentId || null]); } catch (e) {}
  };
  const fail = (res, e) => { console.error(e); res.status(500).json({ error: 'Something went wrong. Please try again.' }); };
  const kes = n => 'KSh ' + Number(n).toLocaleString('en-KE');

  function cleanProperty(b) {
    const title = String(b.title || '').trim();
    const county = String(b.county || '').trim();
    const town = String(b.town || '').trim();
    const rent = Number(b.monthly_rent);
    if (!title || !county || !town) return { error: 'Title, county and town are required.' };
    if (!(rent > 0) || rent > 10000000) return { error: 'Enter a valid monthly rent.' };
    const image = String(b.image_url || '').trim();
    if (image && !/^https?:\/\//i.test(image)) return { error: 'The image link must start with http:// or https://' };
    if (image.length > 500) return { error: 'The image link is too long (500 characters at most).' };
    const imgs = cleanImageUrls(b.image_urls, image);
    if (imgs.error) return { error: imgs.error };
    const whole = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= 50 ? n : d; };
    return { value: {
      title, county, town, monthly_rent: rent,
      bedrooms: whole(b.bedrooms, 1), bathrooms: whole(b.bathrooms, 1),
      address: String(b.address || '').trim() || null,
      image_url: imgs.urls[0] || null,
      image_urls: imgs.urls.length ? JSON.stringify(imgs.urls) : null,
      house_type: String(b.house_type || '').trim().slice(0, 100) || null,
      description: String(b.description || '').trim() || null
    } };
  }

  /* ----- Landlord: full list of own properties (hidden/removed ones are left out) ----- */
  app.get('/api/landlord/properties', need('landlord'), async (req, res) => {
    try {
    const [rows] = await db.query("SELECT * FROM properties WHERE landlord_id=? AND status<>'hidden' ORDER BY created_at DESC", [req.me.id]);
    res.json({ properties: rows });
    } catch (e) { fail(res, e); }
  });

  /* ----- Landlord: edit a property -----
     The listing ID (listing_uid) and the owner can never change (database trigger).
     The county, town and address identify the physical property: they can only be
     changed through an address-change request that an admin approves.            */
  app.put('/api/properties/:id', need('landlord'), async (req, res) => {
    try {
      const [own] = await db.query('SELECT id FROM properties WHERE id=? AND landlord_id=?', [req.params.id, req.me.id]);
      if (!own.length) return res.status(404).json({ error: 'Property not found.' });
      const { error, value } = cleanProperty(req.body || {});
      if (error) return res.status(400).json({ error });
      const [[old]] = await db.query('SELECT county, town, address FROM properties WHERE id=? AND landlord_id=?', [req.params.id, req.me.id]);
      const low = s => String(s || '').trim().toLowerCase();
      if (['county', 'town', 'address'].some(k => low(old[k]) !== low(value[k])))
        return res.status(403).json({ error: 'The county, town and address of a house can only be changed after admin verification. Use "Request address change".' });
      value.county = old.county; value.town = old.town; value.address = old.address;
      await db.query(
        'UPDATE properties SET title=?, county=?, town=?, monthly_rent=?, bedrooms=?, bathrooms=?, address=?, image_url=?, image_urls=?, house_type=?, description=? WHERE id=? AND landlord_id=?',
        [value.title, value.county, value.town, value.monthly_rent, value.bedrooms, value.bathrooms, value.address, value.image_url, value.image_urls, value.house_type, value.description, req.params.id, req.me.id]);
      await audit(req.me.id, 'property_edited', `Property #${req.params.id}`);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  /* ----- Landlord: remove a property -----
     Free plan          -> refused (otherwise a free landlord could swap houses for ever).
     Active tenant      -> refused.
     Has rent history   -> hidden (kept for records, never shown again).
     Never rented       -> deleted for good.                                  */
  app.delete('/api/properties/:id', need('landlord'), async (req, res) => {
    try {
      const [own] = await db.query('SELECT id FROM properties WHERE id=? AND landlord_id=?', [req.params.id, req.me.id]);
      if (!own.length) return res.status(404).json({ error: 'Property not found.' });
      const plan = await subscriptionState(req.me.id);
      if (!plan.active) return res.status(403).json({ error: 'On the free plan, houses cannot be removed. Upgrade your plan to remove or replace a house.' });
      const [active] = await db.query("SELECT id FROM tenancies WHERE property_id=? AND status='active' LIMIT 1", [req.params.id]);
      if (active.length) return res.status(409).json({ error: 'This house has an active tenant. End the tenancy first.' });
      const [[hist]] = await db.query(
        'SELECT (SELECT COUNT(*) FROM tenancies WHERE property_id=?) + (SELECT COUNT(*) FROM expenses WHERE property_id=?) AS n', [req.params.id, req.params.id]);
      if (hist.n > 0) {
        await db.query("UPDATE properties SET status='hidden' WHERE id=? AND landlord_id=?", [req.params.id, req.me.id]);
        await audit(req.me.id, 'property_archived', `Property #${req.params.id}`);
        return res.json({ ok: true, archived: true });
      }
      await db.query('DELETE FROM properties WHERE id=? AND landlord_id=?', [req.params.id, req.me.id]);
      await audit(req.me.id, 'property_deleted', `Property #${req.params.id}`);
      res.json({ ok: true, archived: false });
    } catch (e) { fail(res, e); }
  });

  /* ----- Tenant: submit a rent payment (saved as pending until the landlord verifies) ----- */
  app.post('/api/tenant/payments', need('tenant'), async (req, res) => {
    try {
      const b = req.body || {};
      const amount = Number(b.amount);
      const method = String(b.method || '');
      const period = String(b.period_month || '');
      const reference = String(b.reference || '').trim().toUpperCase();
      const note = String(b.note || '').trim().slice(0, 255) || null;
      if (!(amount > 0) || amount > 10000000) return res.status(400).json({ error: 'Enter a valid amount.' });
      if (!['mpesa', 'bank', 'cash'].includes(method)) return res.status(400).json({ error: 'Choose a payment method.' });
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return res.status(400).json({ error: 'Choose the rent month.' });
      if (method === 'mpesa' && !/^[A-Z0-9]{10}$/.test(reference)) return res.status(400).json({ error: 'The M-Pesa code is 10 letters and numbers.' });
      if (method === 'bank' && !reference) return res.status(400).json({ error: 'Enter the bank reference.' });
      const [t] = await db.query("SELECT id, landlord_id FROM tenancies WHERE id=? AND tenant_id=? AND status='active'", [b.tenancy_id, req.me.id]);
      if (!t.length) return res.status(404).json({ error: 'Active tenancy not found.' });
      if (reference) {
      const [dup] = await db.query("SELECT id FROM payments WHERE reference=? AND status<>'failed' LIMIT 1", [reference]);
      if (dup.length) return res.status(409).json({ error: 'That payment code has already been submitted.' });
      }
      const [r] = await db.query(
        "INSERT INTO payments (tenancy_id, tenant_id, landlord_id, amount, method, reference, period_month, status, recorded_by, note) VALUES (?,?,?,?,?,?,?,'pending',?,?)",
        [t[0].id, req.me.id, t[0].landlord_id, amount, method, reference || null, period, req.me.id, note]);
      const [[u]] = await db.query('SELECT full_name FROM users WHERE id=?', [req.me.id]);
      await notify(t[0].landlord_id, 'payment_submitted', `${u.full_name} submitted ${kes(amount)} for ${period}${reference ? ' (' + reference + ')' : ''}. Please verify.`, r.insertId);
      await audit(req.me.id, 'payment_submitted', `Payment #${r.insertId}, ${kes(amount)}, ${method}`);
      res.json({ ok: true, id: r.insertId });
    } catch (e) { fail(res, e); }
  });

  /* ----- Landlord: payments list (pending first) ----- */
  app.get('/api/landlord/payments', need('landlord'), requirePaid, async (req, res) => {
    try {
      const [rows] = await db.query(
      `SELECT p.id, p.amount, p.method, p.reference, p.mpesa_receipt, p.period_month, p.status, p.note, p.created_at,
      (p.mpesa_checkout_id IS NOT NULL) AS auto,
      u.full_name AS tenant_name, u.phone AS tenant_phone, pr.title AS property_title, t.house_number
      FROM payments p
      JOIN users u ON u.id = p.tenant_id
      JOIN tenancies t ON t.id = p.tenancy_id
      JOIN properties pr ON pr.id = t.property_id
      WHERE p.landlord_id = ?
      ORDER BY (p.status='pending') DESC, p.created_at DESC
      LIMIT 100`, [req.me.id]);
      res.json({ payments: rows });
    } catch (e) { fail(res, e); }
  });

  /* ----- Landlord: verify or reject a pending payment ----- */
  app.post('/api/landlord/payments/:id/verify', need('landlord'), requirePaid, async (req, res) => {
    try {
      const action = (req.body || {}).action;
      if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
      const [rows] = await db.query('SELECT * FROM payments WHERE id=? AND landlord_id=?', [req.params.id, req.me.id]);
      if (!rows.length) return res.status(404).json({ error: 'Payment not found.' });
      const p = rows[0];
      if (p.status !== 'pending') return res.status(409).json({ error: 'This payment has already been handled.' });
      if (p.mpesa_checkout_id) return res.status(409).json({ error: 'M-Pesa prompt payments are confirmed automatically by M-Pesa.' });
      const status = action === 'approve' ? 'paid' : 'failed';
      const [r] = await db.query("UPDATE payments SET status=? WHERE id=? AND landlord_id=? AND status='pending'", [status, p.id, req.me.id]);
      if (!r.affectedRows) return res.status(409).json({ error: 'This payment has already been handled.' });
      await notify(p.tenant_id, action === 'approve' ? 'payment_verified' : 'payment_rejected',
      action === 'approve' ? `Your rent payment of ${kes(p.amount)} for ${p.period_month} was verified.` : `Your rent payment of ${kes(p.amount)} for ${p.period_month} could not be verified. Please contact your landlord.`, p.id);
      await audit(req.me.id, action === 'approve' ? 'payment_verified' : 'payment_rejected', `Payment #${p.id}`);
      res.json({ ok: true, status });
    } catch (e) { fail(res, e); }
  });

  /* ----- Same routes as server.js, now returning image_url (and hiding removed houses).
     Because this file is loaded first, these versions are the ones used. ----- */
  app.get('/api/landlord/summary', need('landlord'), async (req, res) => {
    try {
      const id = req.me.id;
      const manage = (await subscriptionState(id)).manage;
      const [[counts]] = await db.execute(
         "SELECT COUNT(*) total, SUM(status='available') available, SUM(status='occupied') occupied FROM properties WHERE landlord_id=? AND status<>'hidden'", [id]);
      const [[sum]] = await db.execute(
         `SELECT COALESCE(SUM(amount),0) collected FROM payments WHERE landlord_id=? AND status='paid'
          AND DATE_FORMAT(created_at,'%Y-%m')=DATE_FORMAT(CURRENT_DATE(),'%Y-%m')`, [id]);
      const [properties] = await db.execute(
         "SELECT id,title,town,monthly_rent,status,bedrooms,bathrooms,image_url,created_at FROM properties WHERE landlord_id=? AND status<>'hidden' ORDER BY created_at DESC LIMIT 8", [id]);
      const [payments] = await db.execute(
         `SELECT p.amount,p.method,p.reference,p.period_month,p.created_at,u.full_name tenant_name,t.house_number
          FROM payments p JOIN users u ON u.id=p.tenant_id JOIN tenancies t ON t.id=p.tenancy_id
          WHERE p.landlord_id=? AND p.status='paid'
          ORDER BY p.created_at DESC LIMIT 8`, [id]);
      res.json({ counts: { total: counts.total || 0, available: counts.available || 0, occupied: counts.occupied || 0 },
        collected: manage ? (sum.collected || 0) : 0, properties, payments: manage ? payments : [] });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/tenant/overview', need('tenant'), async (req, res) => {
    try {
      const id = req.me.id;
      const [tenancies] = await db.execute(
        `SELECT t.id tenancy_id,t.start_date,t.monthly_rent,t.status,p.title,p.town,p.county,p.address,p.image_url,u.full_name landlord_name,u.phone landlord_phone
        FROM tenancies t JOIN properties p ON p.id=t.property_id JOIN users u ON u.id=t.landlord_id
        WHERE t.tenant_id=? AND t.status='active' ORDER BY t.created_at DESC`, [id]);
      const [payments] = await db.execute(
       'SELECT amount,method,reference,period_month,status,mpesa_receipt,created_at FROM payments WHERE tenant_id=? ORDER BY created_at DESC LIMIT 20', [id]);
      const [requests] = await db.execute(
       'SELECT id,title,description,status,created_at FROM maintenance_requests WHERE tenant_id=? ORDER BY created_at DESC LIMIT 10', [id]);
      res.json({ tenancies, payments, requests });
    } catch (e) { fail(res, e); }
  });
})(app, pool);

app.use(express.static(path.join(__dirname, 'public')));
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please sign in first.' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Please sign in first.' });
    if (req.session.user.role !== role) return res.status(403).json({ error: 'You do not have permission for this action.' });
    next();
  };
}

async function audit(userId, action, details = '') {
  try { await pool.execute('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)', [userId || null, action, details]); }
  catch (e) { console.error('Audit log failed:', e.message); }
}

async function notify(userId, type, message, paymentId = null) {
  try { await pool.execute('INSERT INTO notifications (user_id, type, message, payment_id) VALUES (?, ?, ?, ?)', [userId, type, message, paymentId]); }
  catch (e) { console.error('Notification failed:', e.message); }
}

function cleanUser(u) { return { id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, role: u.role }; }
function validMoney(n) { return Number.isFinite(Number(n)) && Number(n) > 0; }

app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch (e) { res.status(503).json({ ok: false, database: 'unavailable', error: 'Check MySQL settings in .env and make sure MySQL is running.' }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { full_name, email, phone, password, role } = req.body;
    if (!full_name?.trim() || !email?.trim() || !phone?.trim() || !password || !['landlord','tenant'].includes(role))
      return res.status(400).json({ error: 'Fill in all fields and choose landlord or tenant.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (full_name,email,phone,password_hash,role) VALUES (?,?,?,?,?)',
      [full_name.trim(), email.trim().toLowerCase(), phone.trim(), hash, role]
    );
    req.session.user = { id: result.insertId, full_name: full_name.trim(), email: email.trim().toLowerCase(), phone: phone.trim(), role };
    await audit(result.insertId, 'account_registered', `role=${role}`);
    res.status(201).json({ user: req.session.user });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That email address is already registered.' });
    console.error(e); res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash)))
      return res.status(401).json({ error: 'Incorrect email or password.' });
    req.session.user = cleanUser(rows[0]);
    await audit(rows[0].id, 'login', '');
    res.json({ user: req.session.user });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Login failed.' }); }
});

app.post('/api/auth/logout', (req, res) => req.session.destroy(() => {
  res.clearCookie('renthome.sid'); res.json({ ok: true });
}));

/* Forgot password: always the same reply, so nobody can discover who has an account */
app.post('/api/auth/forgot', async (req, res) => {
  const generic = { message: 'If that email is registered, a reset link has been sent. Check your inbox.' };
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Enter your email.' });
    const [rows] = await pool.execute('SELECT id, full_name FROM users WHERE email = ?', [email]);
    if (rows.length && mailer) {
      const [recent] = await pool.execute(
        'SELECT id FROM password_resets WHERE user_id=? AND created_at > (NOW() - INTERVAL 1 MINUTE)', [rows[0].id]);
      if (!recent.length) {
        const token = crypto.randomBytes(32).toString('hex');
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        await pool.execute('DELETE FROM password_resets WHERE user_id=?', [rows[0].id]);
        await pool.execute(
          'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?, DATE_ADD(NOW(), INTERVAL 1 HOUR))',
          [rows[0].id, hash]);
        const link = `${process.env.APP_URL || 'http://localhost:3000'}/reset.html?token=${token}`;
        await mailer.sendMail({
          from: process.env.MAIL_FROM || process.env.SMTP_USER,
          to: email,
          subject: 'Reset your RentHome password',
          text: `Hello ${rows[0].full_name},\n\nUse this link to set a new password (valid for 1 hour):\n${link}\n\nIf you did not ask for this, ignore this email.`
        });
        await audit(rows[0].id, 'password_reset_requested', '');
      }
    }
    res.json(generic);
  } catch (e) { console.error('Forgot password error:', e); res.json(generic); }
});

/* Set the new password using the emailed token */
app.post('/api/auth/reset', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password || String(password).length < 8)
      return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const [rows] = await pool.execute(
      'SELECT id, user_id FROM password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at > NOW()', [hash]);
    if (!rows.length) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    const newHash = await bcrypt.hash(String(password), 10);
    await pool.execute('UPDATE users SET password_hash=? WHERE id=?', [newHash, rows[0].user_id]);
    await pool.execute('UPDATE password_resets SET used_at=NOW() WHERE id=?', [rows[0].id]);
    await audit(rows[0].user_id, 'password_reset_done', '');
    res.json({ message: 'Password changed. You can log in now.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not reset the password.' }); }
});
app.get('/api/auth/me', (req, res) => res.json({ user: req.session.user || null }));

app.get('/api/properties', async (req, res) => {
  try {
    const { q = '', county = '', maxRent = '' } = req.query;
    let sql = `SELECT p.id,p.title,p.description,p.county,p.town,p.address,p.monthly_rent,p.bedrooms,p.bathrooms,p.image_url,p.image_urls,p.house_type,p.status,u.full_name AS landlord_name,u.phone AS landlord_phone
               FROM properties p JOIN users u ON u.id=p.landlord_id WHERE p.status='available'`;
    const args = [];
    if (q) { sql += ' AND (p.title LIKE ? OR p.town LIKE ? OR p.county LIKE ?)'; args.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    if (county) { sql += ' AND p.county = ?'; args.push(county); }
    if (maxRent && validMoney(maxRent)) { sql += ' AND p.monthly_rent <= ?'; args.push(Number(maxRent)); }
    sql += ' ORDER BY p.created_at DESC LIMIT 100';
    const [rows] = await pool.execute(sql, args);
    res.json({ properties: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load houses.' }); }
});

app.post('/api/properties', requireRole('landlord'), async (req, res) => {
  try {
    const { title, description, county, town, address, monthly_rent, bedrooms, bathrooms, image_url, image_urls, house_type } = req.body;
    if (!title?.trim() || !county?.trim() || !town?.trim() || !address?.trim() || !validMoney(monthly_rent))
      return res.status(400).json({ error: 'Title, county, town, full address and a valid monthly rent are required.' });
    const imgs = cleanImageUrls(image_urls, image_url);
    if (imgs.error) return res.status(400).json({ error: imgs.error });
    const plan = await subscriptionState(req.session.user.id);
    if (!plan.can_add) return res.status(402).json({ error: `The free plan allows up to ${plan.free_limit} houses. Upgrade your plan to add more.` });
    const [result] = await pool.execute(
      `INSERT INTO properties (listing_uid,landlord_id,title,description,county,town,address,monthly_rent,bedrooms,bathrooms,image_url,image_urls,house_type)
       VALUES (UUID(),?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.session.user.id, title.trim(), description || '', county.trim(), town.trim(), address.trim(),
       Number(monthly_rent), Math.max(0, Number(bedrooms) || 1), Math.max(0, Number(bathrooms) || 1),
       imgs.urls[0] || null, imgs.urls.length ? JSON.stringify(imgs.urls) : null,
       String(house_type || '').trim().slice(0, 100) || null]
    );
    await audit(req.session.user.id, 'property_created', `property_id=${result.insertId}`);
    res.status(201).json({ id: result.insertId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not save property.' }); }
});

app.get('/api/landlord/summary', requireRole('landlord'), async (req,res) => {
  try {
    const id=req.session.user.id;
    const [[counts]] = await pool.execute(
      `SELECT COUNT(*) total, SUM(status='available') available, SUM(status='occupied') occupied
       FROM properties WHERE landlord_id=?`,[id]);
    const [[money]] = await pool.execute(
      `SELECT COALESCE(SUM(amount),0) collected FROM payments WHERE landlord_id=? AND status='paid'
       AND DATE_FORMAT(created_at,'%Y-%m')=DATE_FORMAT(CURRENT_DATE(),'%Y-%m')`,[id]);
    const [properties] = await pool.execute(
      `SELECT id,title,town,monthly_rent,status,bedrooms,bathrooms,created_at FROM properties WHERE landlord_id=? ORDER BY created_at DESC LIMIT 8`,[id]);
    const [payments] = await pool.execute(
      `SELECT p.amount,p.method,p.reference,p.period_month,p.created_at,u.full_name tenant_name
       FROM payments p JOIN users u ON u.id=p.tenant_id WHERE p.landlord_id=? AND p.status='paid'
       ORDER BY p.created_at DESC LIMIT 8`,[id]);
    res.json({ counts: { total: counts.total||0, available: counts.available||0, occupied: counts.occupied||0 },
      collected: money.collected||0, properties, payments });
  } catch(e) { console.error(e); res.status(500).json({error:'Could not load dashboard.'}); }
});

app.get('/api/landlord/tenants', requireRole('landlord'), requirePaid, async (req,res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT t.id tenancy_id,t.start_date,t.monthly_rent,t.status,
       u.id tenant_id,u.full_name,u.email,u.phone,p.title property_title,p.town,
       COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.tenancy_id=t.id AND pay.status='paid'),0) total_paid
       FROM tenancies t JOIN users u ON u.id=t.tenant_id JOIN properties p ON p.id=t.property_id
       WHERE t.landlord_id=? ORDER BY t.created_at DESC`,[req.session.user.id]);
    res.json({ tenants: rows });
  } catch(e) { console.error(e); res.status(500).json({error:'Could not load tenants.'}); }
});

app.post('/api/landlord/tenancies', requireRole('landlord'), requirePaid, async (req,res) => {
  const conn = await pool.getConnection();
  try {
    const { property_id, tenant_email, start_date } = req.body;
    const houseNo = String(req.body.house_number || '').trim().slice(0, 30);
    if (!property_id || !tenant_email || !start_date || !houseNo) return res.status(400).json({error:'Property, tenant email, house number and start date are required.'});
    await conn.beginTransaction();
    const [props] = await conn.execute("SELECT * FROM properties WHERE id=? AND landlord_id=? FOR UPDATE",[property_id,req.session.user.id]);
    if (!props.length) { await conn.rollback(); return res.status(404).json({error:'Property not found under your account.'}); }
    if (props[0].status !== 'available') { await conn.rollback(); return res.status(409).json({error:'This property is not available.'}); }
    const [tenants] = await conn.execute("SELECT id FROM users WHERE email=? AND role='tenant'",[String(tenant_email).trim().toLowerCase()]);
    if (!tenants.length) { await conn.rollback(); return res.status(404).json({error:'No tenant account found with that email.'}); }
    const [active] = await conn.execute("SELECT id FROM tenancies WHERE property_id=? AND status='active'",[property_id]);
    if (active.length) { await conn.rollback(); return res.status(409).json({error:'This house already has an active tenancy.'}); }
    const [result] = await conn.execute(
    "INSERT INTO tenancies (property_id,landlord_id,tenant_id,start_date,monthly_rent,house_number) VALUES (?,?,?,?,?,?)",
    [property_id,req.session.user.id,tenants[0].id,start_date,props[0].monthly_rent,houseNo]);
    await conn.execute("UPDATE properties SET status='occupied' WHERE id=?",[property_id]);
    await conn.commit();
    await audit(req.session.user.id,'tenancy_created',`tenancy_id=${result.insertId}`);
    res.status(201).json({id:result.insertId});
  } catch(e) { await conn.rollback(); console.error(e); res.status(500).json({error:'Could not create tenancy.'}); }
  finally { conn.release(); }
});

app.post('/api/landlord/payments/manual', requireRole('landlord'), requirePaid, async (req,res) => {
  try {
    const { tenancy_id, amount, method, reference, period_month, note } = req.body;
    if (!tenancy_id || !validMoney(amount) || !/^\d{4}-\d{2}$/.test(period_month||'') || !['cash','bank','other','mpesa'].includes(method))
      return res.status(400).json({error:'Enter a tenancy, valid amount, payment method and month (YYYY-MM).'});
    const [rows] = await pool.execute("SELECT * FROM tenancies WHERE id=? AND landlord_id=? AND status='active'",[tenancy_id,req.session.user.id]);
    if (!rows.length) return res.status(404).json({error:'Active tenancy not found.'});
    const [result] = await pool.execute(
      `INSERT INTO payments (tenancy_id,tenant_id,landlord_id,amount,method,reference,period_month,status,recorded_by,note)
       VALUES (?,?,?,?,?,?,?,'paid',?,?)`,
      [tenancy_id,rows[0].tenant_id,req.session.user.id,Number(amount),method,reference||null,period_month,req.session.user.id,note||null]);
    await audit(req.session.user.id,'manual_payment_recorded',`payment_id=${result.insertId}; tenancy_id=${tenancy_id}`);
    res.status(201).json({id:result.insertId,message:'Manual payment recorded. Keep the supporting receipt/reference for your records.'});
  } catch(e) { console.error(e); res.status(500).json({error:'Could not record payment.'}); }
});

app.get('/api/tenant/overview', requireRole('tenant'), async (req,res) => {
  try {
    const [tenancies] = await pool.execute(
      `SELECT t.id tenancy_id,t.house_number,t.start_date,t.monthly_rent,t.status,p.title,p.town,p.county,p.address,u.full_name landlord_name,u.phone landlord_phone
       FROM tenancies t JOIN properties p ON p.id=t.property_id JOIN users u ON u.id=t.landlord_id
       WHERE t.tenant_id=? AND t.status='active' ORDER BY t.created_at DESC`,[req.session.user.id]);
    const [payments] = await pool.execute(
      `SELECT amount,method,reference,period_month,status,mpesa_receipt,created_at FROM payments
       WHERE tenant_id=? ORDER BY created_at DESC LIMIT 20`,[req.session.user.id]);
    const [requests] = await pool.execute(
      `SELECT id,title,description,status,created_at FROM maintenance_requests WHERE tenant_id=? ORDER BY created_at DESC LIMIT 10`,[req.session.user.id]);
    res.json({tenancies,payments,requests});
  } catch(e) { console.error(e); res.status(500).json({error:'Could not load tenant account.'}); }
});

app.post('/api/tenant/maintenance', requireRole('tenant'), async (req,res) => {
  try {
    const {tenancy_id,title,description} = req.body;
    if (!tenancy_id || !title?.trim()) return res.status(400).json({error:'Choose a tenancy and enter a request title.'});
    const [t] = await pool.execute("SELECT id,landlord_id,house_number FROM tenancies WHERE id=? AND tenant_id=? AND status='active'",[tenancy_id,req.session.user.id]);
    if (!t.length) return res.status(404).json({error:'Active tenancy not found.'});
    const [result] = await pool.execute("INSERT INTO maintenance_requests (tenancy_id,tenant_id,title,description) VALUES (?,?,?,?)",
    [tenancy_id,req.session.user.id,title.trim(),description||'']);
    await notify(t[0].landlord_id, 'maintenance_request', `${req.session.user.full_name}${t[0].house_number ? ' (House ' + t[0].house_number + ')' : ''}: ${title.trim()}`.slice(0, 255));
    res.status(201).json({id:result.insertId});
  } catch(e) { console.error(e); res.status(500).json({error:'Could not send request.'}); }
});


/* ===== M-Pesa: each landlord receives rent in their own account ===== */
const crypto = require('crypto');
function mpesaKey() {
  const k = process.env.MPESA_SECRET_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('MPESA_SECRET_KEY must be 64 hex characters in .env');
  return Buffer.from(k, 'hex');
}
function lock(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', mpesaKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function unlock(packed) {
  const [iv, tag, enc] = String(packed).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', mpesaKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
async function getLandlordMpesa(landlordId) {
  const [rows] = await pool.execute('SELECT * FROM landlord_mpesa WHERE landlord_id=?', [landlordId]);
  if (!rows.length) return null;
  const r = rows[0];
  try {
    return { env: r.env, txn_type: r.txn_type, shortcode: r.shortcode, till_number: r.till_number,
      passkey: unlock(r.passkey_enc), consumer_key: unlock(r.consumer_key_enc), consumer_secret: unlock(r.consumer_secret_enc) };
  } catch (e) { console.error('Could not read M-Pesa settings:', e.message); return null; }
}
const mpesaBaseFor = env => env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
async function mpesaTokenFor(c) {
  const auth = Buffer.from(`${c.consumer_key}:${c.consumer_secret}`).toString('base64');
  const r = await fetch(`${mpesaBaseFor(c.env)}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error('Could not get Daraja access token.');
  return data.access_token;
}
function normalizeKenyanPhone(phone) {
  let p=String(phone||'').replace(/[^\d]/g,'');
  if (p.startsWith('0')) p='254'+p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p='254'+p;
  if (!/^254[17]\d{8}$/.test(p)) return null;
  return p;
}

/* Landlord: read and save their own M-Pesa details (secrets are never sent back) */
app.get('/api/landlord/mpesa', requireRole('landlord'), requirePaid, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT txn_type, shortcode, till_number, env FROM landlord_mpesa WHERE landlord_id=?', [req.session.user.id]);
    if (!rows.length) return res.json({ configured: false, txn_type: 'paybill', shortcode: '', till_number: '', env: 'sandbox' });
    res.json({ configured: true, ...rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load M-Pesa settings.' }); }
});
app.put('/api/landlord/mpesa', requireRole('landlord'), requirePaid, async (req, res) => {
  try {
    const id = req.session.user.id, b = req.body || {};
    const txn_type = b.txn_type === 'till' ? 'till' : 'paybill';
    const env = b.env === 'production' ? 'production' : 'sandbox';
    const shortcode = String(b.shortcode || '').trim();
    const till_number = String(b.till_number || '').trim();
    if (!/^\d{5,10}$/.test(shortcode)) return res.status(400).json({ error: 'Enter a valid shortcode (numbers only).' });
    if (till_number && !/^\d{5,10}$/.test(till_number)) return res.status(400).json({ error: 'The till number must be numbers only.' });
    const [old] = await pool.execute('SELECT * FROM landlord_mpesa WHERE landlord_id=?', [id]);
    const pick = (field, oldEnc) => { const v = String(b[field] || '').trim(); return v ? lock(v) : (oldEnc || null); };
    const passkey_enc = pick('passkey', old[0]?.passkey_enc);
    const consumer_key_enc = pick('consumer_key', old[0]?.consumer_key_enc);
    const consumer_secret_enc = pick('consumer_secret', old[0]?.consumer_secret_enc);
    if (!passkey_enc || !consumer_key_enc || !consumer_secret_enc)
      return res.status(400).json({ error: 'Enter the passkey, consumer key and consumer secret.' });
    await pool.execute(
      `INSERT INTO landlord_mpesa (landlord_id,txn_type,shortcode,till_number,env,passkey_enc,consumer_key_enc,consumer_secret_enc)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE txn_type=VALUES(txn_type), shortcode=VALUES(shortcode), till_number=VALUES(till_number), env=VALUES(env),
         passkey_enc=VALUES(passkey_enc), consumer_key_enc=VALUES(consumer_key_enc), consumer_secret_enc=VALUES(consumer_secret_enc)`,
      [id, txn_type, shortcode, till_number || null, env, passkey_enc, consumer_key_enc, consumer_secret_enc]);
    await audit(id, 'mpesa_settings_saved', `env=${env}; type=${txn_type}`);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not save M-Pesa settings.' }); }
});

/* Tenant: send the prompt using the LANDLORD'S own details */
app.post('/api/mpesa/stkpush', requireRole('tenant'), async (req,res) => {
  try {
    if (!process.env.MPESA_CALLBACK_URL) return res.status(503).json({error:'M-Pesa is not configured yet. Ask the site administrator.'});
    const {tenancy_id,amount,phone,period_month} = req.body;
    if (!tenancy_id || !validMoney(amount) || !/^\d{4}-\d{2}$/.test(period_month||'')) return res.status(400).json({error:'Enter a valid tenancy, amount and rent month.'});
    const normalized=normalizeKenyanPhone(phone);
    if (!normalized) return res.status(400).json({error:'Enter a valid Kenyan mobile number, for example 0712345678.'});
    const [ts]=await pool.execute("SELECT * FROM tenancies WHERE id=? AND tenant_id=? AND status='active'",[tenancy_id,req.session.user.id]);
    if (!ts.length) return res.status(404).json({error:'Active tenancy not found.'});
    const cfg = await getLandlordMpesa(ts[0].landlord_id);
    if (!cfg || !(await subscriptionState(ts[0].landlord_id)).manage) return res.status(409).json({error:'Your landlord has not turned on M-Pesa prompts yet. Pay another way and enter the M-Pesa code instead.'});
    const token=await mpesaTokenFor(cfg);
    const timestamp=new Date().toLocaleString('sv-SE',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).replace(/[^0-9]/g,'').slice(0,14);
    const password=Buffer.from(`${cfg.shortcode}${cfg.passkey}${timestamp}`).toString('base64');
    const isTill = cfg.txn_type === 'till';
    const payload={
      BusinessShortCode:cfg.shortcode,Password:password,Timestamp:timestamp,
      TransactionType:isTill?'CustomerBuyGoodsOnline':'CustomerPayBillOnline',
      Amount:Math.round(Number(amount)),PartyA:normalized,PartyB:(isTill && cfg.till_number)?cfg.till_number:cfg.shortcode,
      PhoneNumber:normalized,CallBackURL:process.env.MPESA_CALLBACK_URL,
      AccountReference:(process.env.MPESA_ACCOUNT_REFERENCE||'RentHome').slice(0,12),
      TransactionDesc:(process.env.MPESA_TRANSACTION_DESC||'RentPayment').slice(0,13)
    };
    const response=await fetch(`${mpesaBaseFor(cfg.env)}/mpesa/stkpush/v1/processrequest`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)
    });
    const data=await response.json();
    if (!response.ok || data.ResponseCode !== '0') return res.status(502).json({error:data.errorMessage||data.ResponseDescription||'M-Pesa request failed.'});
    const [result]=await pool.execute(
      `INSERT INTO payments (tenancy_id,tenant_id,landlord_id,amount,method,reference,period_month,status,recorded_by,mpesa_checkout_id,note)
       VALUES (?,?,?,?, 'mpesa', ?, ?, 'pending', ?, ?, 'Awaiting Daraja callback')`,
      [tenancy_id,req.session.user.id,ts[0].landlord_id,Math.round(Number(amount)),data.MerchantRequestID||null,period_month,req.session.user.id,data.CheckoutRequestID]);
    await audit(req.session.user.id,'mpesa_stk_requested',`payment_id=${result.insertId}`);
    res.json({message:'STK Push sent. Complete the prompt on your phone; payment will show as paid only after Daraja confirms it.'});
  } catch(e) { console.error(e); res.status(502).json({error:'Could not start M-Pesa payment. Check server logs and Daraja settings.'}); }
});

function validCallbackKey(given) {
  const crypto = require('crypto');
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(process.env.MPESA_CALLBACK_SECRET || ''));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/mpesa/callback', async (req,res) => {
  try {
    if (!validCallbackKey(req.query.key)) return res.status(403).json({ResultCode:1,ResultDesc:'Forbidden'});
    const body=req.body?.Body?.stkCallback;
    if (!body?.CheckoutRequestID) return res.json({ResultCode:0,ResultDesc:'Received'});
    if (Number(body.ResultCode) === 0) {
      const items=body.CallbackMetadata?.Item || [];
      const get=(name)=>items.find(x=>x.Name===name)?.Value;
      const receipt=get('MpesaReceiptNumber');
      const amount=get('Amount');
      const phone=get('PhoneNumber');
      const [rows]=await pool.execute("SELECT id,amount,tenant_id,landlord_id,period_month FROM payments WHERE mpesa_checkout_id=? AND status='pending'",[body.CheckoutRequestID]);
      if (rows.length && receipt && Number(amount)===Number(rows[0].amount)) {
        await pool.execute("UPDATE payments SET status='paid',mpesa_receipt=?,reference=?,note=? WHERE id=? AND status='pending'",
          [String(receipt),String(receipt),`Daraja confirmed; phone=${phone||'not supplied'}`,rows[0].id]);
        await audit(null,'mpesa_payment_confirmed',`payment_id=${rows[0].id}; receipt=${receipt}`);
        const [[tn]]=await pool.execute('SELECT full_name FROM users WHERE id=?',[rows[0].tenant_id]);
        await notify(rows[0].landlord_id,'payment_received',`${tn?.full_name||'A tenant'} paid KSh ${Number(amount).toLocaleString('en-KE')} for ${rows[0].period_month} (M-Pesa ${receipt})`,rows[0].id);
      } else if (rows.length) {
        await pool.execute("UPDATE payments SET status='failed',note='Callback amount mismatch or missing receipt' WHERE id=?",[rows[0].id]);
      }else if (receipt) {
        // Late callback: the status check already settled this payment
        const [late]=await pool.execute(
          "SELECT id,amount,status,tenant_id,landlord_id,period_month FROM payments WHERE mpesa_checkout_id=? AND ((status='paid' AND mpesa_receipt IS NULL) OR status='failed') LIMIT 1",
          [body.CheckoutRequestID]);
        if (late.length && Number(amount)===Number(late[0].amount)) {
          const wasFailed = late[0].status==='failed';
          const [u]=await pool.execute(
            "UPDATE payments SET status='paid',mpesa_receipt=?,reference=?,note=? WHERE id=? AND ((status='paid' AND mpesa_receipt IS NULL) OR status='failed')",
            [String(receipt),String(receipt),`Daraja callback (late) confirmed; phone=${phone||'not supplied'}`,late[0].id]);
          if (u.affectedRows) {
            await audit(null,wasFailed?'mpesa_payment_recovered_after_failed':'mpesa_receipt_added_late',`payment_id=${late[0].id}; receipt=${receipt}`);
            if (wasFailed) {
              const [[tn]]=await pool.execute('SELECT full_name FROM users WHERE id=?',[late[0].tenant_id]);
              await notify(late[0].landlord_id,'payment_received',`${tn?.full_name||'A tenant'} paid KSh ${Number(amount).toLocaleString('en-KE')} for ${late[0].period_month} (M-Pesa ${receipt})`,late[0].id);
            }
          }
        }
      }
    } else {
      await pool.execute("UPDATE payments SET status='failed',note=? WHERE mpesa_checkout_id=? AND status='pending'",
        [String(body.ResultDesc||'M-Pesa payment failed').slice(0,255),body.CheckoutRequestID]);
    }
    res.json({ResultCode:0,ResultDesc:'Callback processed'});
  } catch(e) { console.error('M-Pesa callback error:',e); res.status(500).json({ResultCode:1,ResultDesc:'Callback processing failed'}); }
});

app.get('/api/notifications', requireLogin, async (req,res) => {
  try {
    const [notifications] = await pool.execute('SELECT id,type,message,payment_id,is_read,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 30',[req.session.user.id]);
    const [[u]] = await pool.execute('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0',[req.session.user.id]);
    res.json({ notifications, unread: u.c });
  } catch(e) { console.error(e); res.status(500).json({error:'Could not load notifications.'}); }
});
app.post('/api/notifications/read', requireLogin, async (req,res) => {
  try { await pool.execute('UPDATE notifications SET is_read=1 WHERE user_id=? AND is_read=0',[req.session.user.id]); res.json({ok:true}); }
  catch(e) { console.error(e); res.status(500).json({error:'Could not update notifications.'}); }
});


/* ===== Landlord monthly plan =====
   - Free plan: up to FREE_LIMIT houses. Listing more needs the paid plan from day one.
   - The tenant/rent management tools are free for TRIAL_MONTHS, counted from the day of the
     landlord's FIRST listing (never earlier than TRIAL_START, the deployment date).
   - After the trial the management tools need the paid plan (SUB_PRICE per 30 days).        */
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 2);
const SUB_PRICE = Number(process.env.SUB_PRICE || 500);
const TRIAL_MONTHS = Math.max(0, Math.min(24, parseInt(process.env.TRIAL_MONTHS || '3', 10) || 0));
const TRIAL_START = /^\d{4}-\d{2}-\d{2}$/.test(process.env.TRIAL_START || '') ? process.env.TRIAL_START : '1970-01-01';

async function subscriptionState(landlordId) {
  const read = () => pool.execute('SELECT paid_until, trial_ends, (paid_until >= CURDATE()) AS active, (trial_ends >= CURDATE()) AS trial FROM subscriptions WHERE landlord_id=?', [landlordId]);
  let [rows] = await read();
  if (!rows.length || !rows[0].trial_ends) {
    /* the trial starts on the day of the landlord's first listing (never before the deployment date) */
    const [[f]] = await pool.execute('SELECT MIN(created_at) AS first_listing FROM properties WHERE landlord_id=?', [landlordId]);
    if (f.first_listing) {
      await pool.execute(
        `INSERT INTO subscriptions (landlord_id, trial_ends) VALUES (?, DATE_ADD(GREATEST(DATE(?), CAST(? AS DATE)), INTERVAL ${TRIAL_MONTHS} MONTH))
         ON DUPLICATE KEY UPDATE trial_ends = COALESCE(trial_ends, VALUES(trial_ends))`, [landlordId, f.first_listing, TRIAL_START]);
      [rows] = await read();
    }
  }
  const [[cnt]] = await pool.execute("SELECT COUNT(*) AS n FROM properties WHERE landlord_id=? AND status<>'hidden'", [landlordId]);
  const r = rows[0] || {};
  const active = !!r.active, trial_active = !!r.trial, trial_pending = !r.trial_ends;
  return { active, trial_active, trial_pending, manage: active || trial_active || trial_pending,
    paid_until: r.paid_until || null, trial_ends: r.trial_ends || null, trial_months: TRIAL_MONTHS,
    houses: cnt.n, free_limit: FREE_LIMIT, price: SUB_PRICE, can_add: active || cnt.n < FREE_LIMIT };
}

/* Gate for the management tools: allowed during the free trial or with a paid plan */
async function requirePaid(req, res, next) {
  try {
    const plan = await subscriptionState(req.session.user.id);
    if (!plan.manage) return res.status(402).json({ error: 'Your free trial has ended. Upgrade to the monthly plan to manage your tenants and rent.' });
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not check your plan.' }); }
}

app.get('/api/landlord/subscription', requireRole('landlord'), async (req, res) => {
  try { res.json(await subscriptionState(req.session.user.id)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not load your plan.' }); }
});

/* Paying for the plan must never be blocked by the plan itself */
app.post('/api/landlord/subscription/pay', requireRole('landlord'), async (req, res) => {
  try {
    const needed = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_SUB_CALLBACK_URL', 'SUB_CALLBACK_SECRET'];
    if (needed.some(k => !process.env[k])) return res.status(503).json({ error: 'Plan payments are not set up yet.' });
    const phone = normalizeKenyanPhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan mobile number, for example 0712345678.' });
    const cfg = { env: process.env.MPESA_ENV === 'production' ? 'production' : 'sandbox',
      consumer_key: process.env.MPESA_CONSUMER_KEY, consumer_secret: process.env.MPESA_CONSUMER_SECRET };
    const token = await mpesaTokenFor(cfg);
    const timestamp = new Date().toLocaleString('sv-SE', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
    const isTill = !!process.env.MPESA_PLATFORM_TILL;
    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE, Password: password, Timestamp: timestamp,
      TransactionType: isTill ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
      Amount: Math.round(SUB_PRICE), PartyA: phone, PartyB: isTill ? process.env.MPESA_PLATFORM_TILL : process.env.MPESA_SHORTCODE,
      PhoneNumber: phone, CallBackURL: process.env.MPESA_SUB_CALLBACK_URL,
      AccountReference: 'RentHomePlan', TransactionDesc: 'PlanPayment'
    };
    const response = await fetch(`${mpesaBaseFor(cfg.env)}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || data.ResponseCode !== '0') return res.status(502).json({ error: data.errorMessage || data.ResponseDescription || 'M-Pesa request failed.' });
    await pool.execute("INSERT INTO subscription_payments (landlord_id,amount,checkout_id,merchant_id,status) VALUES (?,?,?,?, 'pending')",
      [req.session.user.id, Math.round(SUB_PRICE), data.CheckoutRequestID, data.MerchantRequestID || null]);
    await audit(req.session.user.id, 'subscription_prompt_sent', `checkout=${data.CheckoutRequestID}`);
    res.json({ message: 'Check your phone and enter your M-Pesa PIN. Your plan turns on as soon as M-Pesa confirms.' });
  } catch (e) { console.error(e); res.status(502).json({ error: 'Could not start the payment. Check the server logs and Daraja settings.' }); }
});

app.post('/api/mpesa/sub-callback/:secret', async (req, res) => {
  try {
    if (!process.env.SUB_CALLBACK_SECRET || req.params.secret !== process.env.SUB_CALLBACK_SECRET)
      return res.status(403).json({ ResultCode: 1, ResultDesc: 'Rejected' });
    const body = req.body && req.body.Body && req.body.Body.stkCallback;
    if (!body || !body.CheckoutRequestID) return res.json({ ResultCode: 0, ResultDesc: 'Received' });
    const [rows] = await pool.execute("SELECT id, landlord_id, amount FROM subscription_payments WHERE checkout_id=? AND status='pending'", [body.CheckoutRequestID]);
    if (rows.length) {
      const row = rows[0];
      let paid = false, receipt = null;
      if (Number(body.ResultCode) === 0) {
        const items = (body.CallbackMetadata && body.CallbackMetadata.Item) || [];
        const get = n => { const x = items.find(i => i.Name === n); return x ? x.Value : undefined; };
        receipt = get('MpesaReceiptNumber');
        paid = !!receipt && Number(get('Amount')) === Number(row.amount);
      }
      if (paid) {
        const [u] = await pool.execute("UPDATE subscription_payments SET status='paid', receipt=? WHERE id=? AND status='pending'", [String(receipt), row.id]);
        if (u.affectedRows) {
          await pool.execute(
            `INSERT INTO subscriptions (landlord_id, paid_until) VALUES (?, DATE_ADD(CURDATE(), INTERVAL 30 DAY))
             ON DUPLICATE KEY UPDATE paid_until = DATE_ADD(GREATEST(COALESCE(paid_until, CURDATE()), CURDATE()), INTERVAL 30 DAY)`, [row.landlord_id]);
          await audit(null, 'subscription_paid', `landlord_id=${row.landlord_id}; receipt=${receipt}`);
          await notify(row.landlord_id, 'subscription_paid', 'Your monthly plan is active. Thank you!');
        }
      } else {
        await pool.execute("UPDATE subscription_payments SET status='failed' WHERE id=? AND status='pending'", [row.id]);
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Callback processed' });
  } catch (e) { console.error('Plan callback error:', e); res.status(500).json({ ResultCode: 1, ResultDesc: 'Callback processing failed' }); }
});



/* ===== Address changes need admin verification ===== */
const ADMIN_IDS = String(process.env.ADMIN_USER_IDS || '').split(',').map(s => Number(s.trim())).filter(Boolean);
function requireAdmin(req, res, next) {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: 'Please sign in first.' });
  if (!ADMIN_IDS.includes(u.id)) return res.status(403).json({ error: 'Admins only.' });
  next();
}

app.post('/api/properties/:id/address-request', requireRole('landlord'), async (req, res) => {
  try {
    const b = req.body || {};
    const county = String(b.county || '').trim().slice(0, 100);
    const town = String(b.town || '').trim().slice(0, 100);
    const address = String(b.address || '').trim().slice(0, 255);
    const note = String(b.note || '').trim().slice(0, 1000);
    if (!county || !town || !address || !note) return res.status(400).json({ error: 'Fill in the new county, town, address and the reason.' });
    const [own] = await pool.execute('SELECT id, county, town, address FROM properties WHERE id=? AND landlord_id=?', [req.params.id, req.session.user.id]);
    if (!own.length) return res.status(404).json({ error: 'Property not found.' });
    const o = own[0], low = s => String(s || '').trim().toLowerCase();
    if (low(o.county) === low(county) && low(o.town) === low(town) && low(o.address) === low(address))
    return res.status(400).json({ error: 'That is the same address as now.' });
    const [pending] = await pool.execute("SELECT id FROM address_change_requests WHERE property_id=? AND status='pending' LIMIT 1", [req.params.id]);
    if (pending.length) return res.status(409).json({ error: 'A request for this house is already waiting for the admin.' });
    const [r] = await pool.execute(
      'INSERT INTO address_change_requests (property_id, landlord_id, new_county, new_town, new_address, note) VALUES (?,?,?,?,?,?)',
      [req.params.id, req.session.user.id, county, town, address, note]);
    await audit(req.session.user.id, 'address_change_requested', `property_id=${req.params.id}; request_id=${r.insertId}`);
    res.status(201).json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not send the request.' }); }
});

/* ===== Landlord: maintenance requests ===== */
app.get('/api/landlord/maintenance', requireRole('landlord'), requirePaid, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT m.id, m.title, m.description, m.status, m.created_at,
              u.full_name AS tenant_name, u.phone AS tenant_phone,
              t.house_number, p.title AS property_title, p.town
         FROM maintenance_requests m
         JOIN tenancies t ON t.id = m.tenancy_id
         JOIN users u ON u.id = m.tenant_id
         JOIN properties p ON p.id = t.property_id
        WHERE t.landlord_id = ?
        ORDER BY (m.status = 'completed') ASC, m.created_at DESC
        LIMIT 100`, [req.session.user.id]);
    res.json({ requests: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load maintenance requests.' }); }
});

app.post('/api/landlord/maintenance/:id/status', requireRole('landlord'), requirePaid, async (req, res) => {
  try {
    const status = (req.body || {}).status;
    if (!['open', 'in_progress', 'completed'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const [rows] = await pool.execute(
      `SELECT m.id, m.tenant_id, m.title FROM maintenance_requests m
         JOIN tenancies t ON t.id = m.tenancy_id WHERE m.id = ? AND t.landlord_id = ?`,
      [req.params.id, req.session.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Request not found.' });
    await pool.execute('UPDATE maintenance_requests SET status=? WHERE id=?', [status, rows[0].id]);
    await audit(req.session.user.id, 'maintenance_status', `request_id=${rows[0].id}; status=${status}`);
    await notify(rows[0].tenant_id, 'maintenance_update',
      `Your request "${rows[0].title}" is now ${status.replace('_', ' ')}.`.slice(0, 255));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not update the request.' }); }
});

/* ===== Landlord: end a tenancy ===== */
app.post('/api/landlord/tenancies/:id/end', requireRole('landlord'), requirePaid, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT id, property_id, tenant_id FROM tenancies WHERE id=? AND landlord_id=? AND status='active' FOR UPDATE",
      [req.params.id, req.session.user.id]);
    if (!rows.length) { await conn.rollback(); return res.status(404).json({ error: 'Active tenancy not found.' }); }
    await conn.execute("UPDATE tenancies SET status='ended', end_date=CURDATE() WHERE id=?", [rows[0].id]);
    await conn.execute("UPDATE properties SET status='available' WHERE id=? AND landlord_id=? AND status='occupied'",
      [rows[0].property_id, req.session.user.id]);
    await conn.commit();
    await audit(req.session.user.id, 'tenancy_ended', `tenancy_id=${rows[0].id}`);
    await notify(rows[0].tenant_id, 'tenancy_ended', 'Your tenancy has been ended by your landlord.');
    res.json({ ok: true });
  } catch (e) { try { await conn.rollback(); } catch (x) {} console.error(e); res.status(500).json({ error: 'Could not end the tenancy.' }); }
  finally { conn.release(); }
});

app.get('/api/admin/address-requests', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT r.id, r.property_id, r.new_county, r.new_town, r.new_address, r.note, r.created_at,
              p.title, p.listing_uid, p.county AS old_county, p.town AS old_town, p.address AS old_address,
              u.full_name AS landlord_name, u.phone AS landlord_phone, u.email AS landlord_email,
              (SELECT COUNT(*) FROM properties q WHERE q.id<>p.id AND LOWER(TRIM(q.county))=LOWER(TRIM(r.new_county))
                 AND LOWER(TRIM(q.town))=LOWER(TRIM(r.new_town)) AND LOWER(TRIM(q.address))=LOWER(TRIM(r.new_address))) AS same_address_count
         FROM address_change_requests r JOIN properties p ON p.id=r.property_id JOIN users u ON u.id=r.landlord_id
        WHERE r.status='pending' ORDER BY r.created_at ASC`);
    res.json({ requests: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load requests.' }); }
});

app.post('/api/admin/address-requests/:id/decide', requireAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const action = (req.body || {}).action;
    if (!['approve', 'reject'].includes(action)) { conn.release(); return res.status(400).json({ error: 'Invalid action.' }); }
    const adminNote = String((req.body || {}).admin_note || '').trim().slice(0, 255) || null;
    await conn.beginTransaction();
    const [rows] = await conn.execute("SELECT * FROM address_change_requests WHERE id=? AND status='pending' FOR UPDATE", [req.params.id]);
    if (!rows.length) { await conn.rollback(); return res.status(404).json({ error: 'Request not found or already handled.' }); }
    const r = rows[0];
    if (action === 'approve')
      await conn.execute('UPDATE properties SET county=?, town=?, address=? WHERE id=?', [r.new_county, r.new_town, r.new_address, r.property_id]);
    await conn.execute('UPDATE address_change_requests SET status=?, admin_id=?, admin_note=?, decided_at=NOW() WHERE id=?',
      [action === 'approve' ? 'approved' : 'rejected', req.session.user.id, adminNote, r.id]);
    await conn.commit();
    await audit(req.session.user.id, action === 'approve' ? 'address_change_approved' : 'address_change_rejected', `property_id=${r.property_id}; request_id=${r.id}`);
    await notify(r.landlord_id, 'address_change', action === 'approve' ? 'Your address change was approved.' : 'Your address change was not approved.' + (adminNote ? ' ' + adminNote : ''));
    res.json({ ok: true });
  } catch (e) { try { await conn.rollback(); } catch (x) {} console.error(e); res.status(500).json({ error: 'Could not save the decision.' }); }
  finally { conn.release(); }
});

/* ---- Admin: activity log ---- */
app.get('/api/admin/activity', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const [rows] = await pool.execute(
      `SELECT a.id, a.action, a.details, a.created_at, u.full_name, u.email
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC LIMIT ${limit}`);
    res.json({ activity: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load activity.' }); }
});

/* ---- Admin: user list ---- */
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    let sql = 'SELECT id, full_name, email, phone, role, created_at FROM users';
    const args = [];
    if (q) { sql += ' WHERE full_name LIKE ? OR email LIKE ?'; args.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY id DESC LIMIT 200';
    const [rows] = await pool.execute(sql, args);
    res.json({ users: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load users.' }); }
});

/* ---- Admin: set a temporary password for a user ---- */
app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user.' });
    if (id === req.session.user.id) return res.status(400).json({ error: 'Use "Forgot password?" for your own account.' });
    const [rows] = await pool.execute('SELECT id, full_name FROM users WHERE id=?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    const temp = crypto.randomBytes(8).toString('base64url');
    const hash = await bcrypt.hash(temp, 10);
    await pool.execute('UPDATE users SET password_hash=? WHERE id=?', [hash, id]);
    await pool.execute('DELETE FROM password_resets WHERE user_id=?', [id]);
    await audit(req.session.user.id, 'admin_password_reset', `target_user_id=${id}`);
    res.json({ temp_password: temp, full_name: rows[0].full_name });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not reset the password.' }); }
});

   app.post('/api/mpesa/callback', (req, res) => {
     res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // reply fast
     const cb = req.body?.Body?.stkCallback;
     if (!cb) return;
     // cb.CheckoutRequestID -> find the pending payment in your DB
     // cb.ResultCode === 0  -> paid: read Amount, MpesaReceiptNumber, PhoneNumber
     //                          from cb.CallbackMetadata.Item, mark the payment paid
     // otherwise            -> mark it failed/cancelled
   });

/* ===== Email reminder: plan or trial ends in 3 days or less ===== */
const nodemailer = require('nodemailer');
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;
console.log('SMTP check:', JSON.stringify(process.env.SMTP_USER), (process.env.SMTP_PASS || '').length);

async function sendPlanReminders() {
  if (!mailer) return;
  try {
    const [rows] = await pool.execute(
      `SELECT s.landlord_id, u.full_name, u.email,
              IF(s.paid_until >= CURDATE(), 'monthly plan', 'free trial') AS what,
              DATEDIFF(IF(s.paid_until >= CURDATE(), s.paid_until, s.trial_ends), CURDATE()) AS days_left
         FROM subscriptions s JOIN users u ON u.id = s.landlord_id
        WHERE (s.paid_until BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 3 DAY))
           OR ((s.paid_until IS NULL OR s.paid_until < CURDATE())
               AND s.trial_ends BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 3 DAY))`);
    for (const r of rows) {
      try {
        const [dup] = await pool.execute(
          "SELECT id FROM notifications WHERE user_id=? AND type='plan_reminder' AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY) LIMIT 1",
          [r.landlord_id]);
        if (dup.length) continue;
        const when = r.days_left === 0 ? 'today' : r.days_left === 1 ? 'tomorrow' : `in ${r.days_left} days`;
        await mailer.sendMail({
          from: process.env.MAIL_FROM || process.env.SMTP_USER,
          to: r.email,
          subject: `Your RentHome ${r.what} ends ${when}`,
          text: `Hello ${r.full_name},\n\nYour RentHome ${r.what} ends ${when}.\n\n` +
                `After that you will not be able to manage your tenants, rent payments and maintenance requests. ` +
                `Your houses will stay listed.\n\nTo renew, log in to RentHome, open My properties and click Renew plan ` +
                `(KSh ${SUB_PRICE} for 30 days).\n\nRentHome`
        });
        await notify(r.landlord_id, 'plan_reminder', `Your ${r.what} ends ${when}.`);
      } catch (err) { console.error('Reminder email failed for landlord', r.landlord_id, err.message); }
    }
  } catch (e) { console.error('Plan reminder error:', e.message); }
}
setTimeout(sendPlanReminders, 10000);
setInterval(sendPlanReminders, 6 * 60 * 60 * 1000);

/* ---- Landlord: rent status for the current month ---- */
/* ---- Landlord: rent status (running balance, handles advance and partial payments) ---- */
app.get('/api/landlord/rent-status', requireRole('landlord'), requirePaid, async (req, res) => {
  try {
    const nowN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
    const y0 = nowN.getFullYear(), m0 = nowN.getMonth() + 1, d0 = nowN.getDate();
    const pad = n => String(n).padStart(2, '0');
    const month = `${y0}-${pad(m0)}`;
    const today = `${month}-${pad(d0)}`;
    const GRACE = 6;
    const dayNum = s => { const [a, b, c] = s.split('-').map(Number); return Date.UTC(a, b - 1, c) / 86400000; };
    const addDays = (s, n) => { const [a, b, c] = s.split('-').map(Number); return new Date(Date.UTC(a, b - 1, c + n)).toISOString().slice(0, 10); };
    const anchor = (yy, mm, entryDay) => {
      const dt = new Date(Date.UTC(yy, mm - 1, 1));
      const Y = dt.getUTCFullYear(), M = dt.getUTCMonth() + 1;
      const last = new Date(Date.UTC(Y, M, 0)).getUTCDate();
      return `${Y}-${pad(M)}-${pad(Math.min(entryDay, last))}`;
    };
    const [rows] = await pool.execute(
      `SELECT t.id AS tenancy_id, t.house_number, t.monthly_rent,
              DATE_FORMAT(t.start_date, '%Y-%m-%d') AS start_date_str,
              u.full_name, u.phone, p.title AS property_title,
              COALESCE((SELECT SUM(py.amount) FROM payments py WHERE py.tenancy_id=t.id AND py.status='paid'), 0) AS paid_total,
              (SELECT COUNT(*) FROM payments py WHERE py.tenancy_id=t.id AND py.status='pending') AS pending_count
         FROM tenancies t
         JOIN users u ON u.id=t.tenant_id
         JOIN properties p ON p.id=t.property_id
        WHERE t.landlord_id=? AND t.status='active'
        ORDER BY t.house_number`, [req.session.user.id]);
    const order = { late: 0, due_soon: 1, upcoming: 2, paid: 3 };
    const tenants = rows.map(r => {
      const sy = Number(r.start_date_str.slice(0, 4)), sm = Number(r.start_date_str.slice(5, 7)), entryDay = Number(r.start_date_str.slice(8, 10));
      const rent = Number(r.monthly_rent), paidTotal = Number(r.paid_total);
      const anchorK = k => anchor(sy, sm + k, entryDay);
      const dueK = k => addDays(anchorK(k), GRACE);
      let n = 0;
      while (n < 600 && anchorK(n + 1) <= today) n++;          // rents billed so far
      const covered = rent > 0 ? Math.floor(paidTotal / rent + 1e-9) : n; // rents fully paid for
      let status, due, daysLate = 0, monthsOverdue = 0, monthsAhead = 0;
      if (covered >= n) {
        monthsAhead = covered - n;
        due = dueK(n + 1);
        status = (n === 0 && covered === 0) ? 'upcoming' : 'paid';
      } else {
        monthsOverdue = n - covered;
        due = dueK(covered + 1);
        if (today > due) { status = 'late'; daysLate = dayNum(today) - dayNum(due); }
        else if (dayNum(due) - dayNum(today) <= 3) status = 'due_soon';
        else status = 'upcoming';
      }
      return { tenancy_id: r.tenancy_id, full_name: r.full_name, phone: r.phone, house_number: r.house_number,
        property_title: r.property_title, monthly_rent: rent, paid_amount: paidTotal,
        balance: Math.max(n * rent - paidTotal, 0), due_date: due, status, days_late: daysLate,
        months_overdue: monthsOverdue, months_ahead: monthsAhead, pending: Number(r.pending_count) > 0 };
    }).sort((a, b) => order[a.status] - order[b.status]);
    const summary = { paid: 0, late: 0, due_soon: 0, upcoming: 0 };
    tenants.forEach(t => summary[t.status]++);
    res.json({ month, tenants, summary });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load rent status.' }); }
});

app.get('/api/tenant/rent-status', requireRole('tenant'), async (req, res) => {
  try {
    const nowN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
    const pad = n => String(n).padStart(2, '0');
    const today = `${nowN.getFullYear()}-${pad(nowN.getMonth() + 1)}-${pad(nowN.getDate())}`;
    const GRACE = 6;
    const dayNum = s => { const [a, b, c] = s.split('-').map(Number); return Date.UTC(a, b - 1, c) / 86400000; };
    const addDays = (s, n) => { const [a, b, c] = s.split('-').map(Number); return new Date(Date.UTC(a, b - 1, c + n)).toISOString().slice(0, 10); };
    const anchor = (yy, mm, entryDay) => {
      const dt = new Date(Date.UTC(yy, mm - 1, 1));
      const Y = dt.getUTCFullYear(), M = dt.getUTCMonth() + 1;
      const last = new Date(Date.UTC(Y, M, 0)).getUTCDate();
      return `${Y}-${pad(M)}-${pad(Math.min(entryDay, last))}`;
    };
    const [rows] = await pool.execute(
      `SELECT t.id AS tenancy_id, t.house_number, t.monthly_rent,
              DATE_FORMAT(t.start_date, '%Y-%m-%d') AS start_date_str,
              p.title AS property_title,
              COALESCE((SELECT SUM(py.amount) FROM payments py WHERE py.tenancy_id=t.id AND py.status='paid'), 0) AS paid_total,
              (SELECT COUNT(*) FROM payments py WHERE py.tenancy_id=t.id AND py.status='pending') AS pending_count
         FROM tenancies t
         JOIN properties p ON p.id=t.property_id
        WHERE t.tenant_id=? AND t.status='active'
        ORDER BY t.id`, [req.session.user.id]);
    const tenancies = rows.map(r => {
      const sy = Number(r.start_date_str.slice(0, 4)), sm = Number(r.start_date_str.slice(5, 7)), entryDay = Number(r.start_date_str.slice(8, 10));
      const rent = Number(r.monthly_rent), paidTotal = Number(r.paid_total);
      const anchorK = k => anchor(sy, sm + k, entryDay);
      const dueK = k => addDays(anchorK(k), GRACE);
      let n = 0;
      while (n < 600 && anchorK(n + 1) <= today) n++;
      const covered = rent > 0 ? Math.floor(paidTotal / rent + 1e-9) : n;
      let status, due, daysLate = 0, monthsOverdue = 0, monthsAhead = 0;
      if (covered >= n) {
        monthsAhead = covered - n;
        due = dueK(n + 1);
        status = (n === 0 && covered === 0) ? 'upcoming' : 'paid';
      } else {
        monthsOverdue = n - covered;
        due = dueK(covered + 1);
        if (today > due) { status = 'late'; daysLate = dayNum(today) - dayNum(due); }
        else if (dayNum(due) - dayNum(today) <= 3) status = 'due_soon';
        else status = 'upcoming';
      }
      return { tenancy_id: r.tenancy_id, house_number: r.house_number, property_title: r.property_title,
        monthly_rent: rent, paid_amount: paidTotal,
        balance: Math.max(n * rent - paidTotal, 0), credit: Math.max(paidTotal - n * rent, 0),
        due_date: due, status, days_late: daysLate, months_overdue: monthsOverdue,
        months_ahead: monthsAhead, pending: Number(r.pending_count) > 0 };
    });
    res.json({ tenancies });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load rent status.' }); }
});

let checkingPending = false;
async function checkPendingPayments() {
  if (checkingPending) return;
  checkingPending = true;
  try {
    const [rows] = await pool.execute(
      `SELECT id,landlord_id,tenant_id,amount,period_month,mpesa_checkout_id FROM payments
       WHERE status='pending' AND method='mpesa' AND mpesa_checkout_id IS NOT NULL
         AND created_at < NOW() - INTERVAL 30 SECOND
         AND created_at > NOW() - INTERVAL 1 DAY`);
    for (const p of rows) {
      try {
        const cfg = await getLandlordMpesa(p.landlord_id);
        if (!cfg) continue;
        const token = await mpesaTokenFor(cfg);
        const timestamp = new Date().toLocaleString('sv-SE',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).replace(/[^0-9]/g,'').slice(0,14);
        const password = Buffer.from(`${cfg.shortcode}${cfg.passkey}${timestamp}`).toString('base64');
        const r = await fetch(`${mpesaBaseFor(cfg.env)}/mpesa/stkpushquery/v1/query`,{
          method:'POST',
          headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
          body:JSON.stringify({BusinessShortCode:cfg.shortcode,Password:password,Timestamp:timestamp,CheckoutRequestID:p.mpesa_checkout_id})
        });
        const d = await r.json();
        if (d.ResultCode === undefined) continue; // still processing, try again next round
        if (String(d.ResultCode) === '0') {
          const [u] = await pool.execute(
            "UPDATE payments SET status='paid',note='Confirmed by Daraja status check (no receipt number)' WHERE id=? AND status='pending'",[p.id]);
          if (u.affectedRows) {
            await audit(null,'mpesa_payment_verified_by_query',`payment_id=${p.id}`);
            const [[tn]] = await pool.execute('SELECT full_name FROM users WHERE id=?',[p.tenant_id]);
            await notify(p.landlord_id,'payment_received',`${tn?.full_name||'A tenant'} paid KSh ${Number(p.amount).toLocaleString('en-KE')} for ${p.period_month} (confirmed by M-Pesa status check)`,p.id);
          }
        } else {
          await pool.execute(
            "UPDATE payments SET status='failed',note=? WHERE id=? AND status='pending'",
            [String(d.ResultDesc||'M-Pesa payment failed').slice(0,255),p.id]);
        }
      } catch(e) { console.error('Pending check failed for payment', p.id, e.message); }
    }
  } catch(e) { console.error('Pending check error:', e.message); }
  finally { checkingPending = false; }
}
setInterval(checkPendingPayments, 15 * 1000);

const MAX_REMINDERS = 3; // emails per unpaid rent, one per day
const reminderTransport = require('nodemailer').createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

let sendingReminders = false;
async function sendRentReminders() {
  if (sendingReminders) return;
  sendingReminders = true;
  try {
    const nowN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
    if (nowN.getHours() < 9) return; // reminders go out from 9am Nairobi time
    const pad = n => String(n).padStart(2, '0');
    const today = `${nowN.getFullYear()}-${pad(nowN.getMonth() + 1)}-${pad(nowN.getDate())}`;
    const GRACE = 6;
    const dayNum = s => { const [a, b, c] = s.split('-').map(Number); return Date.UTC(a, b - 1, c) / 86400000; };
    const addDays = (s, n) => { const [a, b, c] = s.split('-').map(Number); return new Date(Date.UTC(a, b - 1, c + n)).toISOString().slice(0, 10); };
    const anchor = (yy, mm, entryDay) => {
      const dt = new Date(Date.UTC(yy, mm - 1, 1));
      const Y = dt.getUTCFullYear(), M = dt.getUTCMonth() + 1;
      const last = new Date(Date.UTC(Y, M, 0)).getUTCDate();
      return `${Y}-${pad(M)}-${pad(Math.min(entryDay, last))}`;
    };
    const [rows] = await pool.execute(
      `SELECT t.id AS tenancy_id, t.landlord_id, t.house_number, t.monthly_rent,
              DATE_FORMAT(t.start_date, '%Y-%m-%d') AS start_date_str,
              u.full_name, u.email, p.title AS property_title,
              COALESCE((SELECT SUM(py.amount) FROM payments py WHERE py.tenancy_id=t.id AND py.status='paid'), 0) AS paid_total
         FROM tenancies t
         JOIN users u ON u.id=t.tenant_id
         JOIN properties p ON p.id=t.property_id
        WHERE t.status='active'`);
    for (const r of rows) {
      try {
        const sy = Number(r.start_date_str.slice(0, 4)), sm = Number(r.start_date_str.slice(5, 7)), entryDay = Number(r.start_date_str.slice(8, 10));
        const rent = Number(r.monthly_rent), paidTotal = Number(r.paid_total);
        const anchorK = k => anchor(sy, sm + k, entryDay);
        const dueK = k => addDays(anchorK(k), GRACE);
        let n = 0;
        while (n < 600 && anchorK(n + 1) <= today) n++;
        const covered = rent > 0 ? Math.floor(paidTotal / rent + 1e-9) : n;
        if (covered >= n) continue;                 // not behind
        const due = dueK(covered + 1);
        if (today <= due) continue;                 // not late yet
        const [[cnt]] = await pool.execute('SELECT COUNT(*) AS c FROM rent_reminders WHERE tenancy_id=? AND due_date=?', [r.tenancy_id, due]);
        if (cnt.c >= MAX_REMINDERS) continue;       // already sent 3, stop
        const [claim] = await pool.execute('INSERT IGNORE INTO rent_reminders (tenancy_id, due_date, sent_on) VALUES (?,?,?)', [r.tenancy_id, due, today]);
        if (!claim.affectedRows) continue;          // already sent today
        const balance = Math.max(n * rent - paidTotal, 0);
        const daysLate = dayNum(today) - dayNum(due);
        const amount = 'KSh ' + balance.toLocaleString('en-KE');
        if (r.email) {
          try {
            await reminderTransport.sendMail({
              from: process.env.MAIL_FROM || process.env.SMTP_USER,
              to: r.email,
              subject: 'Rent reminder: payment is overdue',
              text: `Hello ${r.full_name},\n\nYour rent for ${r.property_title}, house ${r.house_number}, was due on ${due} and is ${daysLate} day${daysLate === 1 ? '' : 's'} late.\nAmount owed: ${amount}.\n\nPlease pay as soon as you can by logging in to RentHome. If you have already paid, you can ignore this message.\n\nRentHome`
            });
          } catch (e) {
            console.error('Reminder email failed for tenancy', r.tenancy_id, e.message);
            await pool.execute('DELETE FROM rent_reminders WHERE id=?', [claim.insertId]); // allow a retry later today
            continue;
          }
        }
        await notify(r.landlord_id, 'rent_late', `${r.full_name} (house ${r.house_number}) is ${daysLate} day${daysLate === 1 ? '' : 's'} late, ${amount} owed`, null);
        await audit(null, 'rent_reminder_sent', `tenancy_id=${r.tenancy_id}; due=${due}; day=${today}`);
      } catch (e) { console.error('Reminder error for tenancy', r.tenancy_id, e.message); }
    }
  } catch (e) { console.error('Reminder job error:', e.message); }
  finally { sendingReminders = false; }
}
setInterval(sendRentReminders, 60 * 60 * 1000); // check hourly; at most one email per tenant per day

const IS_BASE = process.env.INTASEND_BASE_URL || 'https://sandbox.intasend.com';
const INTASEND_PLAN_AMOUNT = Number(process.env.PLAN_PRICE) || 500; // use your own plan price constant if you have one
const isHeaders = () => ({ Authorization: `Bearer ${process.env.INTASEND_SECRET_KEY}`, 'Content-Type': 'application/json' });

function validIntasendChallenge(given) {
  const crypto = require('crypto');
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(process.env.INTASEND_WEBHOOK_CHALLENGE || ''));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// >>> PASTE YOUR EXISTING "plan paid" LOGIC HERE (what your Daraja plan callback does on success) <<<
async function onPlanPaid(landlordId, payment, receiptRef) {
  // e.g. activate or extend the plan for landlordId for 30 days, then:
  await notify(landlordId, 'plan_paid', `Your plan payment of KSh ${Number(payment.amount).toLocaleString('en-KE')} was received (${receiptRef}).`, null);
}

app.post('/api/plan/intasend/stkpush', requireRole('landlord'), async (req, res) => {
  try {
    if (!process.env.INTASEND_SECRET_KEY) return res.status(503).json({ error: 'Payments are not configured yet.' });
    const phone = normalizeKenyanPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan mobile number, for example 0712345678.' });
    const apiRef = require('crypto').randomUUID();
    const [ins] = await pool.execute(
      'INSERT INTO intasend_payments (landlord_id, amount, phone, api_ref) VALUES (?,?,?,?)',
      [req.session.user.id, INTASEND_PLAN_AMOUNT, phone, apiRef]);
    const r = await fetch(`${IS_BASE}/api/v1/payment/mpesa-stk-push/`, {
      method: 'POST', headers: isHeaders(),
      body: JSON.stringify({ amount: INTASEND_PLAN_AMOUNT, phone_number: phone, api_ref: apiRef })
    });
    const d = await r.json();
    const invoiceId = (d.invoice && d.invoice.invoice_id) || d.invoice_id || null;
    if (!r.ok || !invoiceId) {
      console.error('IntaSend STK push failed:', JSON.stringify(d));
      await pool.execute("UPDATE intasend_payments SET status='failed', note=? WHERE id=?", ['STK push request failed', ins.insertId]);
      return res.status(502).json({ error: 'Could not start the M-Pesa payment. Please try again.' });
    }
    await pool.execute('UPDATE intasend_payments SET invoice_id=? WHERE id=?', [invoiceId, ins.insertId]);
    await audit(req.session.user.id, 'plan_stk_requested', `intasend_payment_id=${ins.insertId}`);
    res.json({ message: 'Check your phone and enter your M-Pesa PIN to complete the payment.' });
  } catch (e) { console.error(e); res.status(502).json({ error: 'Could not start the M-Pesa payment.' }); }
});

async function settleIntasendPayment(apiRef, invoiceId) {
  const [rows] = await pool.execute("SELECT * FROM intasend_payments WHERE api_ref=? AND status='pending'", [apiRef]);
  if (!rows.length) return;
  const row = rows[0];
  if (row.invoice_id && row.invoice_id !== invoiceId) return;
  // never trust the webhook body alone: ask IntaSend directly
  const r = await fetch(`${IS_BASE}/api/v1/payment/status/`, {
    method: 'POST', headers: isHeaders(), body: JSON.stringify({ invoice_id: invoiceId })
  });
  const d = await r.json();
  const inv = d.invoice || {};
  console.log('IntaSend status', invoiceId, inv.state, inv.value); // remove after testing
  if (!r.ok || inv.invoice_id !== invoiceId) return;
  if (inv.api_ref && inv.api_ref !== apiRef) return;
  if (inv.state === 'COMPLETE') {
    if (!(Number(inv.value) >= Number(row.amount))) {
      await pool.execute("UPDATE intasend_payments SET status='failed', note='Amount mismatch, check IntaSend dashboard' WHERE id=? AND status='pending'", [row.id]);
      return;
    }
    const [u] = await pool.execute("UPDATE intasend_payments SET status='paid', invoice_id=?, note='Confirmed by IntaSend' WHERE id=? AND status='pending'", [invoiceId, row.id]);
    if (u.affectedRows) {
      await audit(null, 'plan_payment_confirmed', `intasend_payment_id=${row.id}; invoice=${invoiceId}`);
      await onPlanPaid(row.landlord_id, row, invoiceId);
    }
  } else if (inv.state === 'FAILED') {
    await pool.execute("UPDATE intasend_payments SET status='failed', note=? WHERE id=? AND status='pending'",
      [String(inv.failed_reason || 'Payment failed').slice(0, 255), row.id]);
  }
}

app.post('/api/plan/intasend-webhook', async (req, res) => {
  try {
    const b = req.body || {};
    if (!validIntasendChallenge(b.challenge)) return res.status(403).json({ error: 'Forbidden' });
    if (b.invoice_id && b.api_ref) await settleIntasendPayment(String(b.api_ref), String(b.invoice_id));
    res.json({ ok: true });
  } catch (e) { console.error('IntaSend webhook error:', e); res.status(500).json({ error: 'Failed' }); }
});

let checkingIntasend = false;
async function checkPendingIntasend() {
  if (checkingIntasend) return;
  checkingIntasend = true;
  try {
    const [rows] = await pool.execute(
      `SELECT api_ref, invoice_id FROM intasend_payments
        WHERE status='pending' AND invoice_id IS NOT NULL
          AND created_at < NOW() - INTERVAL 30 SECOND AND created_at > NOW() - INTERVAL 1 DAY`);
    for (const p of rows) {
      try { await settleIntasendPayment(p.api_ref, p.invoice_id); }
      catch (e) { console.error('IntaSend pending check failed', p.api_ref, e.message); }
    }
    await pool.execute("UPDATE intasend_payments SET status='failed', note='No response from IntaSend' WHERE status='pending' AND invoice_id IS NULL AND created_at < NOW() - INTERVAL 15 MINUTE");
  } catch (e) { console.error('IntaSend pending check error:', e.message); }
  finally { checkingIntasend = false; }
}
setInterval(checkPendingIntasend, 30 * 1000);

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, () => console.log(`RentHome running at http://localhost:${PORT}`));
