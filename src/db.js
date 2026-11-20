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
