const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { pool, migrate } = require('./db');
const { buildPdf } = require('./pdf');
const { sendReportEmail, mailConfigured } = require('./mail');
const { runImports } = require('./import-once');
const { parseManual } = require('./manual');

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
  data.manualId = Number.isInteger(d.manualId) ? d.manualId : null;
  for (const [k, v] of Object.entries(d.checklist || {}))
    if (/^5\.\d{1,2}\.\d{1,2}$/.test(k) && v && ['ok', 'monitor', 'action', 'urgent', 'na'].includes(v.r))
      data.checklist[k] = { r: v.r, note: clean(v.note, 1500), action: clean(v.action, 1500) };
  data.parts = (Array.isArray(d.parts) ? d.parts : []).slice(0, 60).map(p => ({
    issue: clean(p.issue, 20), desc: clean(p.desc, 300), partNo: clean(p.partNo, 100), qty: clean(p.qty, 20), drawing: clean(p.drawing, 80),
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
  const { rows } = await pool.query('SELECT id, caption, taken_at, data, sec, item FROM photos WHERE report_id=$1 ORDER BY idx', [id]);
  return rows;
}
async function emailReport(r, to) {
  if (!mailConfigured()) {
    await pool.query(`UPDATE reports SET email_status='not_configured', email_error=NULL WHERE id=$1`, [r.id]);
    return { status: 'not_configured' };
  }
  try {
    const pdf = await buildPdf(r, await loadPhotos(r.id));
    const sentTo = await sendReportEmail(r, pdf, to);
    await pool.query(`UPDATE reports SET email_status='sent', email_error=NULL, emailed_at=now(), emailed_to=$2 WHERE id=$1`, [r.id, sentTo.join(', ')]);
    return { status: 'sent', to: sentTo };
  } catch (e) {
    console.error('Email failed', r.ref, e.message);
    await pool.query(`UPDATE reports SET email_status='failed', email_error=$2 WHERE id=$1`, [r.id, e.message.slice(0, 500)]);
    return { status: 'failed', error: e.message };
  }
}
const canSee = (req, r) => req.session.user.role === 'admin' || r.user_id === req.session.user.id;
const canEdit = canSee; // engineers manage their own reports, admins any
const isParker = r => String(r.data?.checklistVersion || '').startsWith('parker');

async function savePhotos(client, id, files, caps) {
  for (let i = 0; i < files.length; i++) {
    const c = caps[i] || {};
    const taken = c.takenAt && !isNaN(Date.parse(c.takenAt)) ? c.takenAt : null;
    const sec = /^(cover|5\.\d{1,2})$/.test(c.sec) ? c.sec : null, item = /^5\.\d{1,2}\.\d{1,2}$/.test(c.item) ? c.item : null;
    await client.query('INSERT INTO photos(report_id,idx,caption,taken_at,mime,data,sec,item) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, i, clean(c.caption, 300), taken, files[i].mimetype, files[i].buffer, sec, item]);
  }
}
function parseUpload(req, res) {
  let d;
  try { d = JSON.parse(req.body.data || '{}'); } catch { res.status(400).json({ error: 'Bad form data.' }); return null; }
  const files = req.files || [];
  if (!files.length) { res.status(400).json({ error: 'Add at least one photo.' }); return null; }
  for (const f of files) if (!/^image\/(jpeg|png)$/.test(f.mimetype)) { res.status(400).json({ error: 'Photos must be JPEG or PNG.' }); return null; }
  const data = sanitizeReport(d);
  if (!data.customer || !data.siteName) { res.status(400).json({ error: 'Customer and site are required.' }); return null; }
  return { d, files, data, caps: Array.isArray(d.photos) ? d.photos : [] };
}

app.post('/api/reports', needAuth, upload.array('photos', 80), wrap(async (req, res) => {
  let d;
  try { d = JSON.parse(req.body.data || '{}'); } catch { return res.status(400).json({ error: 'Bad form data.' }); }
  const clientId = clean(d.clientId, 64);
  if (!clientId) return res.status(400).json({ error: 'Missing report id.' });
  // Same report sent twice from the outbox: return the original instead of a duplicate.
  const dup = await pool.query('SELECT id, ref, email_status FROM reports WHERE client_id=$1 AND user_id=$2', [clientId, req.session.user.id]);
  if (dup.rows[0]) return res.json({ id: dup.rows[0].id, ref: dup.rows[0].ref, email: { status: dup.rows[0].email_status }, duplicate: true });

  const up = parseUpload(req, res); if (!up) return;
  const { files, data, caps } = up;
  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    const ins = await client.query(`INSERT INTO reports(client_id,user_id,data,ref) VALUES($1,$2,$3,'pending') RETURNING id, created_at`, [clientId, req.session.user.id, data]);
    id = ins.rows[0].id;
    const ref = `PI-${new Date(ins.rows[0].created_at).getFullYear()}-${String(id).padStart(4, '0')}`;
    await client.query('UPDATE reports SET ref=$1 WHERE id=$2', [ref, id]);
    await savePhotos(client, id, files, caps);
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
      r.data->>'customer' AS customer, r.data->>'siteName' AS site, u.name AS engineer, u.email AS engineer_email, r.user_id,
      coalesce((r.data->>'revision')::int, 1) AS revision, (r.data->>'checklistVersion') LIKE 'parker%' AS editable,
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

// Everything needed to reopen a report in the form
app.get('/api/reports/:id', needAuth, wrap(async (req, res) => {
  const r = await loadReport(+req.params.id);
  if (!r || !canSee(req, r)) return res.status(404).json({ error: 'Not found' });
  const { rows } = await pool.query('SELECT id, caption, taken_at, sec, item FROM photos WHERE report_id=$1 ORDER BY idx', [r.id]);
  res.json({ id: r.id, ref: r.ref, created_at: r.created_at, user_id: r.user_id, engineer: r.engineer, data: r.data, photos: rows, editable: canEdit(req, r) && isParker(r) });
}));
app.get('/api/reports/:id/photos/:pid', needAuth, wrap(async (req, res) => {
  const r = await loadReport(+req.params.id);
  if (!r || !canSee(req, r)) return res.status(404).send('Not found');
  const { rows } = await pool.query('SELECT mime, data FROM photos WHERE id=$1 AND report_id=$2', [+req.params.pid, r.id]);
  if (!rows[0]) return res.status(404).send('Not found');
  res.set({ 'Content-Type': rows[0].mime, 'Cache-Control': 'private, max-age=3600' }).send(rows[0].data);
}));

// Save an edited report as the next revision (same ref). The edit's clientId makes outbox retries harmless.
app.put('/api/reports/:id', needAuth, upload.array('photos', 80), wrap(async (req, res) => {
  const r = await loadReport(+req.params.id);
  if (!r || !canEdit(req, r)) return res.status(404).json({ error: 'Report not found. It may have been deleted.' });
  if (!isParker(r)) return res.status(400).json({ error: 'Reports made on the old sample checklist can’t be edited.' });
  const up = parseUpload(req, res); if (!up) return;
  const editId = clean(up.d.clientId, 64);
  if (editId && r.data.lastEditId === editId) return res.json({ id: r.id, ref: r.ref, revision: r.data.revision || 1, email: { status: r.email_status }, duplicate: true });
  const data = { ...up.data, revision: (r.data.revision || 1) + 1, revisedAt: new Date().toISOString(), revisedBy: req.session.user.name, lastEditId: editId };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE reports SET data=$1 WHERE id=$2', [data, r.id]);
    await client.query('DELETE FROM photos WHERE report_id=$1', [r.id]);
    await savePhotos(client, r.id, up.files, up.caps);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  const fresh = await loadReport(r.id);
  res.json({ id: r.id, ref: r.ref, revision: data.revision, email: await emailReport(fresh) });
}));

app.delete('/api/reports/:id', needAuth, wrap(async (req, res) => {
  const r = await loadReport(+req.params.id);
  if (!r || !canEdit(req, r)) return res.status(404).json({ error: 'Not found' });
  await pool.query('DELETE FROM reports WHERE id=$1', [r.id]);
  console.log(`Report ${r.ref} deleted by user ${req.session.user.id}`);
  res.json({ ok: true });
}));

// Email the PDF to chosen addresses (default: the engineer who did the inspection)
app.post('/api/reports/:id/email', needAuth, wrap(async (req, res) => {
  const r = await loadReport(+req.params.id);
  if (!r || !canSee(req, r)) return res.status(404).json({ error: 'Not found' });
  if (!mailConfigured()) return res.status(400).json({ error: 'Email isn’t set up on the server yet.' });
  const list = (Array.isArray(req.body.to) ? req.body.to : [r.engineer.email]).map(x => clean(x, 200).toLowerCase()).filter(Boolean);
  if (!list.length || list.length > 10 || !list.every(x => EMAIL_RE.test(x))) return res.status(400).json({ error: 'Enter valid email addresses.' });
  res.json({ email: await emailReport(r, list) });
}));

app.post('/api/reports/:id/resend', needAuth, wrap(async (req, res) => {
  const r = await loadReport(+req.params.id);
  if (!r || !canSee(req, r)) return res.status(404).json({ error: 'Not found' });
  res.json({ email: await emailReport(r) });
}));

/* ---------- parts manuals ---------- */
const manualUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024, files: 1 } });
const manualSummary = `m.id, m.title, m.filename, m.machine_id, m.model, m.customer, m.site, m.status, m.progress, m.error, m.created_at, u.name AS uploaded_by_name, m.uploaded_by,
  coalesce(jsonb_array_length(m.units), 0) AS units, (SELECT count(*) FROM manual_drawings d WHERE d.manual_id = m.id)::int AS drawings,
  coalesce((SELECT sum(jsonb_array_length(x->'rows')) FROM jsonb_array_elements(coalesce(m.units, '[]')) x), 0)::int AS parts`;

app.get('/api/manuals', needAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${manualSummary} FROM manuals m LEFT JOIN users u ON u.id = m.uploaded_by ORDER BY m.created_at DESC`);
  res.json({ manuals: rows });
}));
app.post('/api/manuals', needAuth, manualUpload.single('pdf'), wrap(async (req, res) => {
  const f = req.file;
  if (!f || !/pdf/i.test(f.mimetype) || f.buffer.subarray(0, 4).toString() !== '%PDF') return res.status(400).json({ error: 'Choose a PDF parts manual.' });
  const title = clean(req.body.title, 200) || f.originalname.replace(/\.pdf$/i, '');
  const { rows } = await pool.query(`INSERT INTO manuals(title, filename, customer, site, pdf, uploaded_by, progress) VALUES($1,$2,$3,$4,$5,$6,'Queued') RETURNING id`,
    [title, clean(f.originalname, 200), clean(req.body.customer, 200), clean(req.body.site, 200), f.buffer, req.session.user.id]);
  const id = rows[0].id;
  res.json({ id });
  readManual(id, f.buffer); // in the background; the list shows progress
}));
let manualQueue = Promise.resolve();
function readManual(id, buffer) {
  manualQueue = manualQueue.then(async () => {
    const progress = msg => pool.query('UPDATE manuals SET progress=$2 WHERE id=$1', [id, msg]).catch(() => {});
    try {
      const m = await parseManual(buffer, { password: process.env.MANUAL_PDF_PASSWORD, onProgress: progress });
      if (!m.units.length) throw new Error('No parts lists found. Is this a Parker parts manual?');
      for (const d of m.drawings) await pool.query('INSERT INTO manual_drawings(manual_id, page, title, image) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, d.page, d.title, d.image]);
      await pool.query(`UPDATE manuals SET units=$2, machine_id=$3, model=$4, status='ready', progress=NULL, error=NULL WHERE id=$1`, [id, JSON.stringify(m.units), m.machineId, m.model]);
      console.log(`Manual ${id}: ${m.units.length} units, ${m.units.reduce((a, u) => a + u.rows.length, 0)} parts, ${m.drawings.length} drawings`);
    } catch (e) {
      console.error(`Manual ${id} failed:`, e.message);
      await pool.query(`UPDATE manuals SET status='failed', error=$2, progress=NULL WHERE id=$1`, [id, e.message.slice(0, 300)]).catch(() => {});
    }
  });
}
app.get('/api/manuals/:id', needAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${manualSummary}, m.units AS unit_list FROM manuals m LEFT JOIN users u ON u.id = m.uploaded_by WHERE m.id=$1`, [+req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Manual not found' });
  res.json({ manual: rows[0] });
}));
app.get('/api/manuals/:id/drawings/:page', needAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT image FROM manual_drawings WHERE manual_id=$1 AND page=$2', [+req.params.id, +req.params.page]);
  if (!rows[0]) return res.status(404).send('Not found');
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable' }).send(rows[0].image);
}));
app.get('/api/manuals/:id/pdf', needAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT title, pdf FROM manuals WHERE id=$1', [+req.params.id]);
  if (!rows[0]) return res.status(404).send('Not found');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${rows[0].title.replace(/[^\w .-]/g, '')}.pdf"`, 'Cache-Control': 'private, no-store' }).send(rows[0].pdf);
}));
app.patch('/api/manuals/:id', needAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT uploaded_by FROM manuals WHERE id=$1', [+req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.session.user.role !== 'admin' && rows[0].uploaded_by !== req.session.user.id) return res.status(403).json({ error: 'Only an admin or the person who uploaded it can change this.' });
  for (const k of ['title', 'customer', 'site', 'machine_id', 'model']) if (typeof req.body[k] === 'string') await pool.query(`UPDATE manuals SET ${k}=$2 WHERE id=$1`, [+req.params.id, clean(req.body[k], 200)]);
  res.json({ ok: true });
}));
app.delete('/api/manuals/:id', needAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT uploaded_by FROM manuals WHERE id=$1', [+req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  if (req.session.user.role !== 'admin' && rows[0].uploaded_by !== req.session.user.id) return res.status(403).json({ error: 'Only an admin or the person who uploaded it can delete this.' });
  await pool.query('DELETE FROM manuals WHERE id=$1', [+req.params.id]);
  res.json({ ok: true });
}));

app.get('/healthz', (req, res) => res.send('ok'));

/* ---------- static app ---------- */
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, p) => { if (/\.(html|js|json|webmanifest)$/.test(p)) res.set('Cache-Control', 'no-cache'); },
}));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : 'Upload problem: ' + err.message });
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

migrate().then(runImports).then(() => app.listen(PORT, () => console.log(`Listening on ${PORT}`)))
  .catch(e => { console.error('Startup failed', e); process.exit(1); });
