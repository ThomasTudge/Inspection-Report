// One-off import of a report filled in outside the app (encrypted bundle in imports/, key in the IMPORT_KEY variable).
// Creates the engineer's login if missing, then adds the report to their history. Safe to run repeatedly.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('./db');

async function runImports() {
  const key = process.env.IMPORT_KEY;
  const dir = path.join(__dirname, '..', 'imports');
  if (!key || !fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.enc'))) {
    try { await importFile(path.join(dir, f), key); }
    catch (e) { console.error(`IMPORT ${f}: failed: ${e.message}`); }
  }
}

// File layout: 'PPI2' | salt(16) | iv(12) | tag(16) | ciphertext. Key = scrypt(IMPORT_KEY passphrase, salt).
async function importFile(file, pass) {
  const raw = fs.readFileSync(file);
  if (raw.subarray(0, 4).toString() !== 'PPI2') throw new Error('unknown file format');
  const key = crypto.scryptSync(pass, raw.subarray(4, 20), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(20, 32));
  d.setAuthTag(raw.subarray(32, 48));
  const b = JSON.parse(Buffer.concat([d.update(raw.subarray(48)), d.final()]).toString());

  let { rows } = await pool.query('SELECT id, active FROM users WHERE lower(email)=$1', [b.user.email.toLowerCase()]);
  let userId;
  if (rows[0]) {
    userId = rows[0].id;
    console.log(`IMPORT: ${b.user.email} already has an account (user ${userId}${rows[0].active ? '' : ', disabled'})`);
  } else {
    const ins = await pool.query(`INSERT INTO users(name,email,role,password_hash,must_change_password) VALUES($1,$2,'engineer',$3,true) RETURNING id`,
      [b.user.name, b.user.email.toLowerCase(), b.user.passwordHash]);
    userId = ins.rows[0].id;
    console.log(`IMPORT: created account for ${b.user.email} (user ${userId}) with a temporary password`);
  }

  const dup = await pool.query('SELECT id, ref FROM reports WHERE client_id=$1', [b.report.clientId]);
  if (dup.rows[0]) { console.log(`IMPORT: report already imported as ${dup.rows[0].ref}`); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`INSERT INTO reports(client_id,user_id,data,ref,created_at,email_status) VALUES($1,$2,$3,'pending',$4,'not_configured') RETURNING id`,
      [b.report.clientId, userId, b.report.data, b.report.createdAt]);
    const id = r.rows[0].id, ref = `PI-${new Date(b.report.createdAt).getFullYear()}-${String(id).padStart(4, '0')}`;
    await client.query('UPDATE reports SET ref=$1 WHERE id=$2', [ref, id]);
    for (let i = 0; i < b.photos.length; i++) {
      const p = b.photos[i];
      await client.query('INSERT INTO photos(report_id,idx,caption,taken_at,mime,data,sec,item) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, i, p.caption, p.takenAt, 'image/jpeg', Buffer.from(p.b64, 'base64'), p.sec, p.item]);
    }
    await client.query('COMMIT');
    const n = await pool.query('SELECT count(*)::int AS n FROM reports WHERE user_id=$1', [userId]);
    console.log(`IMPORT: added ${ref} (${b.report.data.customer}, ${b.report.data.siteName}, ${b.photos.length} photos) to user ${userId}; they now have ${n.rows[0].n} report(s)`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

module.exports = { runImports };
