const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { pool, migrate } = require('./db');
const { buildPdf } = require('./pdf');
const { sendReportEmail, mailConfigured } = require('./mail');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});

if (PROD && !process.env.SESSION_SECRET) { console.error('SESSION_SECRET must be set'); process.exit(1); }
app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  name: 'ppi.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 1000 * 60 * 60 * 24 * 30 },
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 80 } });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const needAuth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Please sign in.' });
const needAdmin = (req, res, next) => req.session.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' });
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, mustChangePassword: u.must_change_password });
const clean = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const sig = v => typeof v === 'string' && v.startsWith('data:image/png;base64,') && v.length < 400000 ? v : null;
const oneOf = (v, list) => list.includes(v) ? v : null;

// Accepts the Parker form (checklistVersion parker-*) and reports still queued on phones from the old sample checklist.
function sanitizeReport(d) {
  const legacy = !String(d.checklistVersion || '').startsWith('parker');
  const data = {
    customer: clean(d.customer, 200), siteName: clean(d.siteName, 200),
    plantModel: clean(d.plantModel, 200), serialNumber: clean(d.serialNumber, 100),
    visitStart: d.visitStart && !isNaN(Date.parse(d.visitStart)) ? d.visitStart : null,
    location: d.location && isFinite(d.location.lat) && isFinite(d.location.lng) ? { lat: +d.location.lat, lng: +d.location.lng, accuracy: +d.location.accuracy || null } : null,
    checklist: {},
    customerName: clean(d.customerName, 200), customerEmail: EMAIL_RE.test(clean(d.customerEmail, 200)) ? clean(d.customerEmail, 200) : '',
    signature: sig(d.signature), checklistVersion: clean(d.checklistVersion, 40),
  };
  if (legacy) {
    Object.assign(data, { siteAddress: clean(d.siteAddress, 400), plantHours: clean(d.plantHours, 50), summary: clean(d.summary, 6000), recommendations: clean(d.recommendations, 6000) });
    for (const [k, v] of Object.entries(d.checklist || {}))
      if (/^[a-z]+-\d+$/.test(k) && v && ['good', 'monitor', 'action', 'na'].includes(v.r)) data.checklist[k] = { r: v.r, note: clean(v.note, 1000) };
    return data;
  }
  for (const k of ['projectNo', 'plantType', 'engineers', 'siteContact', 'statusNote', 'hoursSince', 'previousRef', 'nextInspection']) data[k] = clean(d[k], 300);
  for (const k of ['conditions', 'topConcerns', 'recBefore', 'recShutdown', 'recSpares', 'recFurther']) data[k] = clean(d[k], 4000);
  data.inspectionDate = /^\d{4}-\d{2}-\d{2}$/.test(d.inspectionDate) ? d.inspectionDate : null;
  data.statusRunning = d.statusRunning === true; data.statusShutdown = d.statusShutdown === true;
  data.safety = Array.isArray(d.safety) ? d.safety.slice(0, 20).map(x => x === true) : [];
  data.overall = oneOf(d.overall, ['ok', 'monitor', 'action', 'urgent']);
  data.safe = oneOf(d.safe, ['yes', 'conditions', 'no']);
  data.engineerSignature = sig(d.engineerSignature);
  for (const [k, v] of Object.entries(d.checklist || {}))
    if (/^5\.\d{1,2}\.\d{1,2}$/.test(k) && v && ['ok', 'monitor', 'action', 'urgent', 'na'].includes(v.r))
      data.checklist[k] = { r: v.r, note: clean(v.note, 1500), action: clean(v.action, 1500) };
  data.parts = (Array.isArray(d.parts) ? d.parts : []).slice(0, 60).map(p => ({
    issue: clean(p.issue, 20), desc: clean(p.desc, 300), partNo: clean(p.partNo, 100), qty: clean(p.qty, 20),
    needed: oneOf(p.needed, ['now', 'shutdown', 'spare']), quote: p.quote === true,
  })).filter(p => p.desc || p.partNo);
  return data;
}

/* ---------- auth ---------- */
const attempts = new Map();
app.post('/api/login', wrap(async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const key = `${req.ip}|${email}`;
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email)=$1 AND active', [email]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
    a.n++; attempts.set(key, a);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  attempts.delete(key);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not sign in.' });
    req.session.user = { id: u.id, name: u.name, email: u.email, role: u.role };
    res.json({ user: publicUser(u) });
  });
}));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', needAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1 AND active', [req.session.user.id]);
  if (!rows[0]) { req.session.destroy(() => {}); return res.status(401).json({ error: 'Please sign in.' }); }
  res.json({ user: publicUser(rows[0]), mail: mailConfigured() });
}));
app.post('/api/password', needAuth, wrap(async (req, res) => {
  const next = String(req.body.newPassword || '');
  if (next.length < 8) return res.status(400).json({ error: 'Use at least 8 characters.' });
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.user.id]);
  if (!(await bcrypt.compare(String(req.body.currentPassword || ''), rows[0].password_hash)))
    return res.status(400).json({ error: 'Current password is incorrect.' });
  await pool.query('UPDATE users SET password_hash=$1, must_change_password=false WHERE id=$2', [await bcrypt.hash(next, 11), rows[0].id]);
  res.json({ ok: true });
}));

/* ---------- users (admin) ---------- */
app.get('/api/users', needAuth, needAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT u.id,u.name,u.email,u.role,u.active,u.created_at,
    (SELECT count(*) FROM reports r WHERE r.user_id=u.id)::int AS reports FROM users u ORDER BY u.active DESC, u.name`);
  res.json({ users: rows });
}));
app.post('/api/users', needAuth, needAdmin, wrap(async (req, res) => {
  const name = clean(req.body.name, 120), email = clean(req.body.email, 200).toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'engineer';
  const password = String(req.body.password || '');
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a name and a valid email.' });
  if (password.length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO users(name,email,role,password_hash,must_change_password) VALUES($1,$2,$3,$4,true) RETURNING id',
      [name, email, role, await bcrypt.hash(password, 11)]);
    res.json({ id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That email already has an account.' });
    throw e;
  }
}));
app.patch('/api/users/:id', needAuth, needAdmin, wrap(async (req, res) => {
  const id = +req.params.id;
  if (id === req.session.user.id && (req.body.active === false || req.body.role === 'engineer'))
    return res.status(400).json({ error: 'You can’t remove your own admin access.' });
  if (typeof req.body.active === 'boolean') await pool.query('UPDATE users SET active=$1 WHERE id=$2', [req.body.active, id]);
  if (req.body.role === 'admin' || req.body.role === 'engineer') await pool.query('UPDATE users SET role=$1 WHERE id=$2', [req.body.role, id]);
  if (req.body.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
    await pool.query('UPDATE users SET password_hash=$1, must_change_password=true WHERE id=$2', [await bcrypt.hash(String(req.body.password), 11), id]);
    await pool.query(`DELETE FROM session WHERE (sess->'user'->>'id')::int = $1`, [id]).catch(() => {});
  }
  if (req.body.active === false) await pool.query(`DELETE FROM session WHERE (sess->'user'->>'id')::int = $1`, [id]).catch(() => {});
  res.json({ ok: true });
}));

/* ---------- reports ---------- */
async function loadReport(id) {
  const { rows } = await pool.query(`SELECT r.*, u.name AS eng_name, u.email AS eng_email FROM reports r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, [id]);
  if (!rows[0]) return null;
  const r = rows[0];
  r.engineer = { name: r.eng_name, email: r.eng_email };
  return r;
}
async function loadPhotos(id) {
  const { rows } = await pool.query('SELECT caption, taken_at, data, sec, item FROM photos WHERE report_id=$1 ORDER BY idx', [id]);
  return rows;
}
async function emailReport(r) {
  if (!mailConfigured()) {
    await pool.query(`UPDATE reports SET email_status='not_configured', email_error=NULL WHERE id=$1`, [r.id]);
    return { status: 'not_configured' };
  }
  try {
    const pdf = await buildPdf(r, await loadPhotos(r.id));
    const to = await sendReportEmail(r, pdf);
    await pool.query(`UPDATE reports SET email_status='sent', email_error=NULL, emailed_at=now(), emailed_to=$2 WHERE id=$1`, [r.id, to.join(', ')]);
    return { status: 'sent', to };
  } catch (e) {
    console.error('Email failed', r.ref, e.message);
    await pool.query(`UPDATE reports SET email_status='failed', email_error=$2 WHERE id=$1`, [r.id, e.message.slice(0, 500)]);
    return { status: 'failed', error: e.message };
  }
}
const canSee = (req, r) => req.session.user.role === 'admin' || r.user_id === req.session.user.id;

app.post('/api/reports', needAuth, upload.array('photos', 80), wrap(async (req, res) => {
  let d;
  try { d = JSON.parse(req.body.data || '{}'); } catch { return res.status(400).json({ error: 'Bad form data.' }); }
  const clientId = clean(d.clientId, 64);
  if (!clientId) return res.status(400).json({ error: 'Missing report id.' });
  // Same report sent twice from the outbox: return the original instead of a duplicate.
  const dup = await pool.query('SELECT id, ref, email_status FROM reports WHERE client_id=$1 AND user_id=$2', [clientId, req.session.user.id]);
  if (dup.rows[0]) return res.json({ id: dup.rows[0].id, ref: dup.rows[0].ref, email: { status: dup.rows[0].email_status }, duplicate: true });

  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Add at least one photo.' });
  for (const f of files) if (!/^image\/(jpeg|png)$/.test(f.mimetype)) return res.status(400).json({ error: 'Photos must be JPEG or PNG.' });
  const caps = Array.isArray(d.photos) ? d.photos : [];
  const data = sanitizeReport(d);
  if (!data.customer || !data.siteName) return res.status(400).json({ error: 'Customer and site are required.' });

  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    const ins = await client.query(`INSERT INTO reports(client_id,user_id,data,ref) VALUES($1,$2,$3,'pending') RETURNING id, created_at`, [clientId, req.session.user.id, data]);
    id = ins.rows[0].id;
    const ref = `PI-${new Date(ins.rows[0].created_at).getFullYear()}-${String(id).padStart(4, '0')}`;
    await client.query('UPDATE reports SET ref=$1 WHERE id=$2', [ref, id]);
    for (let i = 0; i < files.length; i++) {
      const c = caps[i] || {};
      const taken = c.takenAt && !isNaN(Date.parse(c.takenAt)) ? c.takenAt : null;
      const sec = /^(cover|5\.\d{1,2})$/.test(c.sec) ? c.sec : null, item = /^5\.\d{1,2}\.\d{1,2}$/.test(c.item) ? c.item : null;
      await client.query('INSERT INTO photos(report_id,idx,caption,taken_at,mime,data,sec,item) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, i, clean(c.caption, 300), taken, files[i].mimetype, files[i].buffer, sec, item]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      const again = await pool.query('SELECT id, ref, email_status FROM reports WHERE client_id=$1', [clientId]);
      if (again.rows[0]) return res.json({ id: again.rows[0].id, ref: again.rows[0].ref, email: { status: again.rows[0].email_status }, duplicate: true });
    }
    throw e;
  } finally { client.release(); }

  const r = await loadReport(id);
  const email = await emailReport(r);
  res.json({ id, ref: r.ref, email });
}));

app.get('/api/reports', needAuth, wrap(async (req, res) => {
  const all = req.session.user.role === 'admin' && req.query.all === '1';
  const { rows } = await pool.query(`SELECT r.id, r.ref, r.created_at, r.email_status, r.email_error, r.emailed_to,
      r.data->>'customer' AS customer, r.data->>'siteName' AS site, u.name AS engineer,
      (SELECT count(*) FROM photos p WHERE p.report_id=r.id)::int AS photos,
      (SELECT count(*) FROM jsonb_each(r.data->'checklist') e WHERE e.value->>'r' IN ('action','urgent'))::int AS actions
    FROM reports r JOIN users u ON u.id=r.user_id ${all ? '' : 'WHERE r.user_id=$1'} ORDER BY r.created_at DESC LIMIT 200`,
    all ? [] : [req.session.user.id]);
  res.json({ reports: rows });
}));

app.get('/api/reports/:id/pdf', needAuth, wrap(async (req, res) => {
  const r = await loadReport(+req.params.id);
  if (!r || !canSee(req, r)) return res.status(404).send('Not found');
  const pdf = await buildPdf(r, await loadPhotos(r.id));
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${r.ref}.pdf"`, 'Cache-Control': 'private, no-store' });
  res.send(pdf);
}));

app.post('/api/reports/:id/resend', needAuth, wrap(async (req, res) => {
  const r = await loadReport(+req.params.id);
  if (!r || !canSee(req, r)) return res.status(404).json({ error: 'Not found' });
  res.json({ email: await emailReport(r) });
}));

app.get('/healthz', (req, res) => res.send('ok'));

/* ---------- static app ---------- */
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, p) => { if (/\.(html|js|json|webmanifest)$/.test(p)) res.set('Cache-Control', 'no-cache'); },
}));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A photo is too large.' : 'Upload problem: ' + err.message });
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

migrate().then(() => app.listen(PORT, () => console.log(`Listening on ${PORT}`)))
  .catch(e => { console.error('Startup failed', e); process.exit(1); });
