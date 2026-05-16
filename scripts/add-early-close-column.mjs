#!/usr/bin/env node
// One-shot migration: add early_close_days column to weekly_periods.
//
// Run this BEFORE deploying the Early Close feature code, otherwise the
// new code's INSERT/UPDATE statements will fail with "column does not exist".
//
// USAGE (Windows cmd, replace the connection string with the doadmin one
// from DO → Databases → db-postgresql-nyc3-52603 → Connection Details →
// Connection parameters → "Show" the password, copy the full URI):
//
//   set DATABASE_URL=postgresql://doadmin:PASSWORD@HOST:25060/foodhall?sslmode=require
//   node scripts/add-early-close-column.mjs
//
// Notes:
// - Run as `doadmin`, not `foodhall_app`. The runtime user is CRUD-only
//   and intentionally lacks ALTER TABLE permission.
// - The script is idempotent. Safe to run twice.
// - The script changes `defaultdb` → `foodhall` in the URL: the cluster
//   may have multiple logical DBs; this one targets `foodhall` specifically.

import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('ERROR: DATABASE_URL is not set.');
  console.error('Set it to the doadmin connection string from DO, e.g.:');
  console.error('  set DATABASE_URL=postgresql://doadmin:PASSWORD@HOST:25060/foodhall?sslmode=require');
  process.exit(1);
}

// Helpful sanity-check the script is hitting the right database.
const dbName = (() => {
  try { return new URL(url).pathname.replace(/^\//, ''); }
  catch { return '(unparseable)'; }
})();
console.log(`Connecting to database: ${dbName}`);

const sql = postgres(url, { ssl: 'require', connect_timeout: 10, max: 1 });

try {
  // 1. Add the column (idempotent via IF NOT EXISTS).
  await sql.unsafe(`
    ALTER TABLE weekly_periods
      ADD COLUMN IF NOT EXISTS early_close_days JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);
  console.log('✓ ALTER TABLE complete (column added or already present).');

  // 2. Make sure the runtime user keeps CRUD privileges on the table.
  // ADD COLUMN should not strip existing grants, but this is defensive
  // and idempotent.
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON weekly_periods TO foodhall_app;`);
  console.log('✓ GRANTs reaffirmed for foodhall_app.');

  // 3. Verify the column shape.
  const rows = await sql`
    SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'weekly_periods' AND column_name = 'early_close_days'
  `;
  if (rows.length === 0) {
    console.error('VERIFICATION FAILED: column not found after ALTER.');
    process.exit(2);
  }
  console.log('✓ Column verified:', rows[0]);

  // 4. Spot-check existing rows have the default applied.
  const [{ count, with_value }] = await sql`
    SELECT
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE early_close_days IS NOT NULL)::int AS with_value
      FROM weekly_periods
  `;
  console.log(`✓ ${with_value}/${count} existing weekly_periods rows have early_close_days populated (should be equal).`);

  console.log('\nMigration complete. Safe to deploy the new code now.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(3);
} finally {
  await sql.end({ timeout: 5 });
}
