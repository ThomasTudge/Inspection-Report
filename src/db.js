const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL must be set'); process.exit(1); }
const pool = new Pool({
  connectionString: url,
  ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'engineer',
      password_hash TEXT NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      ref TEXT NOT NULL,
      client_id TEXT NOT NULL UNIQUE,
      user_id INT NOT NULL REFERENCES users(id),
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      email_status TEXT,
      email_error TEXT,
      emailed_at TIMESTAMPTZ,
      emailed_to TEXT
    );
    CREATE INDEX IF NOT EXISTS reports_user_idx ON reports (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      report_id INT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      idx INT NOT NULL,
      caption TEXT,
      taken_at TIMESTAMPTZ,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL
    );
    CREATE INDEX IF NOT EXISTS photos_report_idx ON photos (report_id, idx);
  `);

  // One-off account setup from SET_USERS: JSON array of {email, password, name?, role?}.
  // Creates missing accounts or resets the password of existing ones. Clear the variable afterwards,
  // otherwise these passwords are reapplied on every restart.
  if (process.env.SET_USERS) {
    let list = [];
    try { list = JSON.parse(process.env.SET_USERS); } catch { console.warn('SET_USERS is not valid JSON; ignored.'); }
    for (const u of Array.isArray(list) ? list : []) {
      const email = String(u.email || '').trim().toLowerCase();
      if (email && u.active === false) {
        const off = await pool.query('UPDATE users SET active=false WHERE lower(email)=$1 RETURNING id', [email]);
        if (off.rowCount) console.log(`SET_USERS: disabled user ${off.rows[0].id}`);
        continue;
      }
      if (!email || !u.password) continue;
      const hash = await bcrypt.hash(String(u.password), 11);
      const role = u.role === 'admin' ? 'admin' : 'engineer';
      const name = u.name || email.split('@')[0].split('.').map(s => s[0].toUpperCase() + s.slice(1)).join(' ');
      const upd = await pool.query('UPDATE users SET password_hash=$1, must_change_password=false, active=true WHERE lower(email)=$2 RETURNING id', [hash, email]);
      if (upd.rowCount) { console.log(`SET_USERS: password reset for user ${upd.rows[0].id}`); continue; }
      const ins = await pool.query('INSERT INTO users(name,email,role,password_hash,must_change_password) VALUES($1,$2,$3,$4,false) RETURNING id', [name, email, role, hash]);
      console.log(`SET_USERS: created user ${ins.rows[0].id} (${role})`);
    }
  }

  // First admin, created once from environment variables.
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || '';
    if (!email || password.length < 8) {
      console.warn('No users yet: set ADMIN_EMAIL and ADMIN_PASSWORD (8+ characters) to create the first admin.');
      return;
    }
    await pool.query(
      `INSERT INTO users(name,email,role,password_hash,must_change_password) VALUES($1,$2,'admin',$3,true)`,
      [process.env.ADMIN_NAME || 'Administrator', email, await bcrypt.hash(password, 11)]);
    console.log(`Created first admin ${email}`);
  }
}

module.exports = { pool, migrate };
