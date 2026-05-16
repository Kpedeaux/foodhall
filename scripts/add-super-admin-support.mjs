#!/usr/bin/env node
// One-shot migration: enable super_admin role + nullable market_id.
//
// Run BEFORE deploying the Super Admin feature code, otherwise the
// bootstrap on first boot will fail with constraint violations.
//
// USAGE:
//   set DATABASE_URL=postgresql://doadmin:PASSWORD@HOST:25060/foodhall?sslmode=require
//   node scripts/add-super-admin-support.mjs
//
// Idempotent: safe to run multiple times.

import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('ERROR: DATABASE_URL is not set. See script header for usage.');
  process.exit(1);
}

const dbName = (() => { try { return new URL(url).pathname.replace(/^\//, ''); } catch { return '(unparseable)'; } })();
console.log(`Connecting to database: ${dbName}`);
const sql = postgres(url, { ssl: 'require', connect_timeout: 10, max: 1 });

try {
  // 1. Drop existing role CHECK constraint by introspection (auto-named by Postgres).
  await sql.unsafe(`
    DO $$
    DECLARE
      con_name text;
    BEGIN
      SELECT conname INTO con_name
        FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%role%';
      IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE users DROP CONSTRAINT ' || quote_ident(con_name);
        RAISE NOTICE 'Dropped existing role check: %', con_name;
      END IF;
    END $$;
  `);
  console.log('✓ Dropped any existing role CHECK constraint.');

  // 2. Add new role CHECK that allows super_admin.
  await sql.unsafe(`
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin', 'vendor', 'super_admin'));
  `);
  console.log('✓ Added new role CHECK including super_admin.');

  // 3. Make market_id nullable. Super admins are not market-scoped.
  await sql.unsafe(`ALTER TABLE users ALTER COLUMN market_id DROP NOT NULL;`);
  console.log('✓ users.market_id is now nullable.');

  // 4. Composite constraint: super_admin must have NULL market_id; others must have a market_id.
  await sql.unsafe(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_market_role_consistency;`);
  await sql.unsafe(`
    ALTER TABLE users ADD CONSTRAINT users_market_role_consistency
      CHECK (
        (role = 'super_admin' AND market_id IS NULL) OR
        (role IN ('admin', 'vendor') AND market_id IS NOT NULL)
      );
  `);
  console.log('✓ Added composite constraint enforcing role/market_id consistency.');

  // 5. Reaffirm grants for the runtime user.
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON users TO foodhall_app;`);
  console.log('✓ GRANTs reaffirmed for foodhall_app.');

  // 6. Verify.
  const constraints = await sql`
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'users'::regclass AND contype = 'c'
      ORDER BY conname
  `;
  console.log('Final CHECK constraints on users:');
  for (const c of constraints) console.log(`  - ${c.conname}: ${c.def}`);

  console.log('\nMigration complete. Safe to deploy the Super Admin code now.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(2);
} finally {
  await sql.end({ timeout: 5 });
}
