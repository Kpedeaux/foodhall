import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;

export function getDb() {
  if (db) return db;

  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'food-hall.db');
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

export function initDb() {
  const db = getDb();

  // Run schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Migrations for existing databases
  const migrations = [
    { table: 'weekly_periods', column: 'closure_days', sql: "ALTER TABLE weekly_periods ADD COLUMN closure_days TEXT NOT NULL DEFAULT '[]'" },
    { table: 'daily_calculations', column: 'is_closure_day', sql: "ALTER TABLE daily_calculations ADD COLUMN is_closure_day INTEGER NOT NULL DEFAULT 0" },
    { table: 'vendors', column: 'departed_date', sql: "ALTER TABLE vendors ADD COLUMN departed_date TEXT" },
    // Security: account lockout columns
    { table: 'users', column: 'failed_login_attempts', sql: "ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0" },
    { table: 'users', column: 'locked_until', sql: "ALTER TABLE users ADD COLUMN locked_until TEXT" },
    // Balance carryover: track what a vendor owes from previous weeks
    { table: 'weekly_summaries', column: 'prior_balance_due', sql: "ALTER TABLE weekly_summaries ADD COLUMN prior_balance_due REAL NOT NULL DEFAULT 0" },
    { table: 'weekly_summaries', column: 'balance_due', sql: "ALTER TABLE weekly_summaries ADD COLUMN balance_due REAL NOT NULL DEFAULT 0" },
  ];
  for (const m of migrations) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all();
    if (!cols.some(c => c.name === m.column)) {
      db.exec(m.sql);
      console.log(`  Migrated: added ${m.column} to ${m.table}`);
    }
  }

  // Canonical list of allowed adjustment types. Keep in sync with schema.sql
  // CHECK constraint and with the ADJ_TYPES dropdown on the client.
  const ALLOWED_ADJUSTMENT_TYPES = ['linen', 'fine', 'equipment', 'credit', 'deposit', 'other'];

  // Rebuild the `adjustments` table whenever its CHECK constraint is missing
  // any of the currently-allowed types. This runs idempotently on every boot
  // so new types added to ALLOWED_ADJUSTMENT_TYPES above flow through to
  // production DBs on the next server start — no hand-written migrations needed.
  try {
    const checkSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='adjustments'").get();
    if (checkSql && checkSql.sql) {
      const missing = ALLOWED_ADJUSTMENT_TYPES.filter(t => !checkSql.sql.includes(`'${t}'`));
      if (missing.length > 0) {
        console.log(`  Migrating adjustments CHECK constraint to include: ${missing.join(', ')}...`);
        const typeList = ALLOWED_ADJUSTMENT_TYPES.map(t => `'${t}'`).join(', ');
        db.exec(`
          CREATE TABLE IF NOT EXISTS adjustments_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            weekly_summary_id INTEGER NOT NULL REFERENCES weekly_summaries(id) ON DELETE CASCADE,
            type TEXT NOT NULL CHECK (type IN (${typeList})),
            amount REAL NOT NULL,
            description TEXT,
            created_by INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO adjustments_new SELECT * FROM adjustments;
          DROP TABLE adjustments;
          ALTER TABLE adjustments_new RENAME TO adjustments;
          CREATE INDEX IF NOT EXISTS idx_adjustments_summary ON adjustments(weekly_summary_id);
        `);
        console.log('  ✅ Adjustments table migrated');
      }
    }
  } catch (err) {
    console.error('  Warning: adjustments migration failed:', err.message);
  }

  // Versioned migrations tracked in schema_migrations table.
  // Use this for any one-time data (not schema) migrations going forward.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 2026-04 migration: flip the sign convention for adjustments.
  //
  // OLD convention: amount was stored as a POSITIVE value meaning "deduction"
  //   and recalcNetTransfer computed:  net = gross - SUM(amount) - prior.
  //
  // NEW convention (accounting standard): amount is SIGNED.
  //   positive = credit to vendor, negative = fine/deduction, and
  //   recalcNetTransfer now computes:  net = gross + SUM(amount) - prior.
  //
  // We negate every existing adjustment row so previously-stored
  // net_transfer / balance_due values remain numerically correct under
  // the new formula (gross + SUM(-old) - prior == gross - SUM(old) - prior).
  try {
    const migName = '2026_04_flip_adjustment_sign_convention';
    const already = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migName);
    if (!already) {
      const result = db.prepare('UPDATE adjustments SET amount = -amount').run();
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migName);
      if (result.changes > 0) {
        console.log(`  ✅ Flipped sign on ${result.changes} existing adjustment row(s) to new signed convention`);
      }
    }
  } catch (err) {
    console.error('  Warning: adjustment sign migration failed:', err.message);
  }

  // Seed if empty
  const marketCount = db.prepare('SELECT COUNT(*) as count FROM markets').get();
  if (marketCount.count === 0) {
    console.log('📦 Seeding database...');

    // SECURITY: previous versions seeded an admin user with the hardcoded
    // password "changeme". That value is treated as compromised and is no
    // longer accepted. To bootstrap a fresh install, set environment vars:
    //   INITIAL_ADMIN_PASSWORD   (required, 12+ chars)
    //   INITIAL_ADMIN_USERNAME   (optional, default: "ashley")
    //   INITIAL_ADMIN_EMAIL      (optional)
    //   INITIAL_MARKET_NAME      (optional, default: "St. Roch Market")
    // The seed runs ONCE when the markets table is empty.
    const initialPassword = process.env.INITIAL_ADMIN_PASSWORD;
    const initialUsername = process.env.INITIAL_ADMIN_USERNAME || 'ashley';
    const initialEmail = process.env.INITIAL_ADMIN_EMAIL || null;
    const initialMarketName =
      process.env.INITIAL_MARKET_NAME || 'St. Roch Market';
    if (!initialPassword || initialPassword.length < 12) {
      console.error('');
      console.error(
        'Refusing to seed: INITIAL_ADMIN_PASSWORD env var is not set, or is shorter than 12 chars.',
      );
      console.error(
        'Set INITIAL_ADMIN_PASSWORD to a strong password (12+ chars) and restart.',
      );
      console.error('');
      process.exit(1);
    }
    if (initialPassword === 'changeme' || initialPassword === 'strochadmin') {
      console.error('INITIAL_ADMIN_PASSWORD must not be a known default value.');
      process.exit(1);
    }

    // Create the market
    const insertMarket = db.prepare(`
      INSERT INTO markets (name, square_environment, default_delivery_fee_rate, default_service_charge_rate)
      VALUES (?, ?, ?, ?)
    `);
    const marketResult = insertMarket.run(initialMarketName, 'production', 0.105, 0.02);
    const marketId = marketResult.lastInsertRowid;

    // Create the initial admin
    const hash = bcrypt.hashSync(initialPassword, 12);
    const insertUser = db.prepare(`
      INSERT INTO users (market_id, username, password_hash, role, email, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertUser.run(marketId, initialUsername, hash, 'admin', initialEmail, 1);

    console.log(
      `✅ Database seeded: ${initialMarketName} + admin user "${initialUsername}" (must change password on first login)`,
    );
  }

  return db;
}

// Helper: log an action to the audit log
export function auditLog(marketId, userId, action, entityType, entityId, details) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (market_id, user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(marketId, userId, action, entityType, entityId, typeof details === 'string' ? details : JSON.stringify(details));
}
