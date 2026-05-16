// Food Hall Manager — Postgres data layer
//
// Uses postgres.js (https://github.com/porsager/postgres) which exposes a
// tagged-template client:
//
//   const rows = await sql`SELECT * FROM vendors WHERE market_id = ${marketId}`;
//   const [user] = await sql`SELECT * FROM users WHERE id = ${userId}`;
//   const [inserted] = await sql`INSERT INTO vendors ${sql(payload)} RETURNING id`;
//
// All values interpolated via ${...} are safely parameterized — never
// string-concatenate into a sql`` tag.

import postgres from 'postgres';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set.');
  console.error('Local dev: docker run --name fh-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16');
  console.error('           DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres');
  console.error('Production (DO App Platform): inject ${db.DATABASE_URL} from your Managed Postgres binding.');
  process.exit(1);
}

// ── Connection ──────────────────────────────────────────────
// DO Managed Postgres requires TLS. We accept the platform-provided
// certificate without pinning a CA here because App Platform injects
// the connection string with `?sslmode=require` and trusts the cert
// chain through the runtime image's CA bundle.
const sslMode =
  process.env.DATABASE_SSL === 'disable' ? false :
  process.env.NODE_ENV === 'production' ? 'require' :
  'prefer';

const sql = postgres(process.env.DATABASE_URL, {
  ssl: sslMode,
  max: Number(process.env.PG_POOL_MAX || 10),
  idle_timeout: 30,
  connect_timeout: 10,
  // Return numeric/decimal columns as JS numbers (matching prior REAL behavior).
  // If we move to NUMERIC for money later, we'll revisit this.
  types: {
    // NUMERIC → JS number (matching prior REAL behavior).
    numeric: { from: [1700], parse: (v) => Number(v) },
    // DATE → ISO 'YYYY-MM-DD' string (matching prior SQLite TEXT behavior).
    // We deliberately do NOT override TIMESTAMPTZ (oid 1184), which stays as Date.
    date: { from: [1082], parse: (v) => v },
  },
});

export { sql };

// ── auditLog helper ─────────────────────────────────────────
// NOTE: now async. Every caller that does `auditLog(...)` must `await`.
// `details` may be null, a string, or any JSON-serializable value.
export async function auditLog(marketId, userId, action, entityType, entityId, details) {
  // Use sql.json() so postgres.js tags the value as JSONB (oid 3802) for
  // proper round-trip parsing on read. If `details` is a string assumed to
  // already be JSON, parse it first.
  const detailsValue = details == null
    ? null
    : (typeof details === 'string' ? JSON.parse(details) : details);
  await sql`
    INSERT INTO audit_log (market_id, user_id, action, entity_type, entity_id, details)
    VALUES (${marketId}, ${userId}, ${action}, ${entityType}, ${entityId},
            ${detailsValue == null ? null : sql.json(detailsValue)})
  `;
}

// ── Schema initialization + first-boot seed ─────────────────
// Idempotent. Run once on server startup. Safe to call repeatedly.
//
// In production, the runtime DB user (e.g. foodhall_app) is intentionally
// scoped to CRUD-only — it doesn't have CREATE on public schema. So we
// detect whether the schema has already been applied (sentinel: the
// `markets` table) and skip the apply step if so. Schema application is
// a one-time deployment task run with an elevated user (doadmin) via the
// import script or psql, not by the running app.
export async function initDb() {
  const [{ exists: schemaApplied }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'markets'
    ) AS exists
  `;

  if (!schemaApplied) {
    // 1a. Fresh database — apply schema now. This requires CREATE on public
    // schema; if the current user lacks it, the deploy will fail loudly
    // with a permission error pointing at this exact step.
    console.log('Schema not detected; applying from schema.pg.sql...');
    const schemaPath = path.join(__dirname, 'schema.pg.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await sql.unsafe(schema);
    console.log('Schema applied.');
  } else {
    console.log('Schema already applied; skipping CREATE TABLE statements.');
  }

  // 2a. Bootstrap initial super admin (cross-tenant operator). Runs every
  // boot but is a no-op if any super_admin row already exists, or if the
  // INITIAL_SUPER_ADMIN_* env vars aren't set. Placed BEFORE the
  // market-empty check so existing databases still get bootstrapped on
  // first deploy of the super-admin feature.
  await bootstrapSuperAdmin();

  // 2b. First-boot seed: only runs if markets table is empty.
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM markets`;
  if (count > 0) return;

  console.log('📦 Seeding empty database with initial market + admin user...');

  // SECURITY: refuse to seed without an explicit strong INITIAL_ADMIN_PASSWORD.
  // No hardcoded defaults — "changeme" and "strochadmin" are treated as known-compromised.
  const initialPassword = process.env.INITIAL_ADMIN_PASSWORD;
  const initialUsername = process.env.INITIAL_ADMIN_USERNAME || 'ashley';
  const initialEmail    = process.env.INITIAL_ADMIN_EMAIL || null;
  const initialMarket   = process.env.INITIAL_MARKET_NAME || 'St. Roch Market';

  if (!initialPassword || initialPassword.length < 12) {
    console.error('');
    console.error('Refusing to seed: INITIAL_ADMIN_PASSWORD env var is missing or shorter than 12 chars.');
    console.error('Set INITIAL_ADMIN_PASSWORD to a strong password (12+ chars) and restart.');
    console.error('');
    process.exit(1);
  }
  if (initialPassword === 'changeme' || initialPassword === 'strochadmin') {
    console.error('INITIAL_ADMIN_PASSWORD must not be a known default value.');
    process.exit(1);
  }

  // Wrap the seed in a transaction so a partial failure doesn't leave a
  // market without its bootstrap admin.
  await sql.begin(async (sql) => {
    const [market] = await sql`
      INSERT INTO markets (name, square_environment, default_delivery_fee_rate, default_service_charge_rate)
      VALUES (${initialMarket}, 'production', 0.105, 0.02)
      RETURNING id
    `;
    const hash = bcrypt.hashSync(initialPassword, 12);
    await sql`
      INSERT INTO users (market_id, username, password_hash, role, email, must_change_password)
      VALUES (${market.id}, ${initialUsername}, ${hash}, 'admin', ${initialEmail}, TRUE)
    `;
  });

  console.log(`✅ Seeded: market "${initialMarket}" + admin user "${initialUsername}" (must change password on first login)`);
}

async function bootstrapSuperAdmin() {
  const username = process.env.INITIAL_SUPER_ADMIN_USERNAME;
  const password = process.env.INITIAL_SUPER_ADMIN_PASSWORD;
  if (!username || !password) return; // bootstrap env vars not set — silent no-op

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE role = 'super_admin'`;
  if (count > 0) return; // already bootstrapped — silent no-op

  if (password.length < 12) {
    console.error('Refusing to bootstrap super admin: INITIAL_SUPER_ADMIN_PASSWORD shorter than 12 chars.');
    return;
  }
  if (password === 'changeme' || password === 'password') {
    console.error('Refusing to bootstrap super admin: INITIAL_SUPER_ADMIN_PASSWORD must not be a known default value.');
    return;
  }

  try {
    const hash = bcrypt.hashSync(password, 12);
    await sql`
      INSERT INTO users (market_id, username, password_hash, role, must_change_password)
      VALUES (NULL, ${username}, ${hash}, 'super_admin', TRUE)
    `;
    console.log(`✅ Bootstrapped initial super admin "${username}" (must change password on first login)`);
  } catch (err) {
    if (err.code === '23505') {
      console.error(`Cannot bootstrap super admin: username "${username}" already exists. Choose a different INITIAL_SUPER_ADMIN_USERNAME.`);
    } else {
      console.error('Super admin bootstrap failed:', err.message);
    }
  }
}

// ── Graceful shutdown ───────────────────────────────────────
// App Platform sends SIGTERM on redeploy; flush the pool so in-flight
// queries finish and connections release cleanly.
async function shutdown(signal) {
  console.log(`Received ${signal}, closing Postgres pool...`);
  try {
    await sql.end({ timeout: 5 });
  } catch (e) {
    console.error('Error closing Postgres pool:', e.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
