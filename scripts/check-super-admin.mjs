#!/usr/bin/env node
// Diagnostic: show all super_admin rows in the database.
// Usage:
//   set DATABASE_URL=<doadmin connection string>
//   node scripts/check-super-admin.mjs

import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = postgres(url, { ssl: 'require', max: 1 });

try {
  const rows = await sql`
    SELECT id, username, market_id, role, active, must_change_password, created_at
      FROM users
      WHERE role = 'super_admin'
      ORDER BY id
  `;
  if (rows.length === 0) {
    console.log('NO super_admin rows in the database.');
    console.log('That means the bootstrap did not insert one. Likely causes:');
    console.log('  - INITIAL_SUPER_ADMIN_USERNAME / INITIAL_SUPER_ADMIN_PASSWORD missing or empty');
    console.log('  - Password shorter than 12 chars');
    console.log('  - Password is "changeme" or "password" (blocked defaults)');
    console.log('  - Username collides with an existing user');
    console.log('  - Bootstrap threw an error — check runtime logs');
  } else {
    console.log(`Found ${rows.length} super_admin row(s):`);
    for (const r of rows) console.log(' ', r);
  }
} catch (err) {
  console.error('Query failed:', err.message);
  process.exit(2);
} finally {
  await sql.end({ timeout: 5 });
}
