// Server-code smoke test (no SQLite involved).
// Boots pglite as a TCP server, applies schema, seeds synthetic data,
// then imports the converted database.js and exercises query patterns
// from every converted route file.

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import fs from 'fs';
import bcrypt from 'bcryptjs';

const pg = await PGlite.create();
const server = new PGLiteSocketServer({ db: pg, port: 5433, host: '127.0.0.1' });
await server.start();
console.log('pglite TCP server ready on localhost:5433');

process.env.DATABASE_URL = 'postgres://postgres:@127.0.0.1:5433/template1';
process.env.DATABASE_SSL = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'a'.repeat(64);

// Apply schema directly via pglite
const schema = fs.readFileSync('./server/db/schema.pg.sql', 'utf8');
await pg.exec(schema);
console.log('schema applied');

// Seed synthetic data covering every table the routes touch
const hash = bcrypt.hashSync('test-password-1234', 4); // low cost for speed
await pg.exec(`
  INSERT INTO markets (name, square_environment) VALUES ('Test Hall', 'production');
`);
await pg.query(
  `INSERT INTO vendors (market_id, name, square_location_id, plan_type, percentage_rate, daily_base_rent, active, is_excluded)
   VALUES (1, $1, $2, 'STANDARD', 0.30, 25.00, TRUE, FALSE)`,
  ['Test Vendor A', 'sq_loc_001']
);
await pg.query(
  `INSERT INTO users (market_id, username, password_hash, role, vendor_id, active, must_change_password)
   VALUES (1, 'ashley', $1, 'admin', NULL, TRUE, FALSE)`,
  [hash]
);
await pg.query(
  `INSERT INTO users (market_id, username, password_hash, role, vendor_id, active, must_change_password)
   VALUES (1, 'vendor-a', $1, 'vendor', 1, TRUE, FALSE)`,
  [hash]
);
await pg.query(
  `INSERT INTO weekly_periods (market_id, week_start, week_end, is_linen_week, closure_days, status, approved_at)
   VALUES (1, '2026-05-04', '2026-05-10', FALSE, '[]'::jsonb, 'approved', now())`
);
await pg.query(
  `INSERT INTO weekly_summaries (weekly_period_id, vendor_id, total_sales, gross_transfer, net_transfer, tips_to_transfer)
   VALUES (1, 1, 5432.10, 4000.00, 3950.00, 200.00)`
);
await pg.query(
  `INSERT INTO daily_calculations (weekly_period_id, vendor_id, date, total_sales, payment_count, is_closure_day)
   VALUES (1, 1, '2026-05-04', 800.00, 25, FALSE)`
);
await pg.query(
  `INSERT INTO adjustments (weekly_summary_id, type, amount, description, created_by)
   VALUES (1, 'fine', -50.00, 'Late cleaning', 1)`
);
console.log('synthetic data seeded');

// Now exercise the actual converted code paths
const { sql, auditLog } = await import('./server/db/database.js');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else      { console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); fail++; }
}

console.log('\n=== auth.js patterns ===');
const [loginUser] = await sql`
  SELECT u.*, v.name AS vendor_name FROM users u LEFT JOIN vendors v ON u.vendor_id = v.id
  WHERE LOWER(u.username) = LOWER(${'ashley'}) AND u.active = TRUE`;
check('login lookup returns user', loginUser && loginUser.username === 'ashley');
check('  bcrypt.compareSync still verifies hash', bcrypt.compareSync('test-password-1234', loginUser.password_hash));
check('  user.active is JS boolean', typeof loginUser.active === 'boolean');

const [meUser] = await sql`
  SELECT u.id, u.username, u.role, u.market_id, u.vendor_id, u.must_change_password, v.name AS vendor_name
  FROM users u LEFT JOIN vendors v ON u.vendor_id = v.id WHERE u.id = ${loginUser.id} AND u.active = TRUE`;
check('/me lookup works', meUser && meUser.id === loginUser.id);
check('  must_change_password is JS boolean', typeof meUser.must_change_password === 'boolean');

console.log('\n=== lockout.js patterns ===');
const { checkLockout, recordFailedAttempt, resetFailedAttempts } = await import('./server/middleware/lockout.js');
let lock = await checkLockout('ashley');
check('checkLockout fresh user: not locked', lock.locked === false);
for (let i = 0; i < 5; i++) await recordFailedAttempt('ashley');
lock = await checkLockout('ashley');
check('after 5 failed attempts: locked', lock.locked === true);
check('  minutes left ~30', lock.minutesLeft >= 29 && lock.minutesLeft <= 30);
await resetFailedAttempts(loginUser.id);
lock = await checkLockout('ashley');
check('after reset: not locked', lock.locked === false);

console.log('\n=== admin.js patterns ===');
const vendors = await sql`SELECT * FROM vendors WHERE market_id = ${1} ORDER BY name`;
check('GET /vendors returns rows', vendors.length === 1 && vendors[0].name === 'Test Vendor A');
check('  active comes back as boolean', typeof vendors[0].active === 'boolean');

const [newVendor] = await sql`
  INSERT INTO vendors (market_id, name, plan_type, percentage_rate, daily_base_rent,
                       delivery_fee_rate, service_charge_rate, weekly_minimum, linen_charge,
                       active, is_excluded)
  VALUES (1, 'Created Vendor', 'STANDARD', 0.30, 0, 0.105, 0.02, 0, 0, TRUE, FALSE)
  RETURNING id`;
check('POST /vendors RETURNING id works', newVendor && newVendor.id > 1);

const weeks = await sql`
  SELECT wp.*, u.username AS approved_by_username FROM weekly_periods wp
  LEFT JOIN users u ON wp.approved_by = u.id
  WHERE wp.market_id = ${1} ORDER BY wp.week_start DESC`;
check('GET /admin/weeks returns rows', weeks.length === 1);
check('  closure_days is parsed JSON array', Array.isArray(weeks[0].closure_days));
check('  week_start is ISO date string (not Date object)', typeof weeks[0].week_start === 'string' && weeks[0].week_start === '2026-05-04');

const [adj] = await sql`SELECT COALESCE(SUM(amount), 0) AS total FROM adjustments WHERE weekly_summary_id = ${1}`;
check('recalcNetTransfer math reads sum', adj.total === -50);

console.log('\n=== vendors.js patterns (vendor portal) ===');
const vendorWeeks = await sql`
  SELECT wp.id, wp.week_start, ws.net_transfer FROM weekly_periods wp
  JOIN weekly_summaries ws ON ws.weekly_period_id = wp.id
  WHERE wp.market_id = ${1} AND wp.status = 'approved' AND ws.vendor_id = ${1}
    AND wp.week_start >= ${'2026-01-01'}`;
check('vendor sees their own approved weeks', vendorWeeks.length === 1);
check('  net_transfer is number', typeof vendorWeeks[0].net_transfer === 'number');

console.log('\n=== calculator.js transaction pattern ===');
// Just verify sql.begin works for delete+insert atomicity
await sql.begin(async (sql) => {
  await sql`DELETE FROM adjustments WHERE id = 1`;
  await sql`INSERT INTO adjustments (weekly_summary_id, type, amount, description, created_by) VALUES (1, 'credit', 25, 'Refund', 1)`;
});
const [adjAfter] = await sql`SELECT type, amount FROM adjustments WHERE weekly_summary_id = 1`;
check('sql.begin transaction commits', adjAfter && adjAfter.type === 'credit' && adjAfter.amount === 25);

console.log('\n=== auditLog ===');
await auditLog(1, 1, 'test_action', 'test_entity', 999, { foo: 'bar', n: 42 });
const [logged] = await sql`SELECT * FROM audit_log WHERE action = 'test_action'`;
check('auditLog inserts row', !!logged);
check('  details is parsed object', logged && typeof logged.details === 'object' && logged.details.foo === 'bar');

console.log(`\n${pass} pass, ${fail} fail`);
await sql.end();
await server.stop();
process.exit(fail > 0 ? 1 : 0);
