#!/usr/bin/env node
//
// One-shot migration tool: copy Ashley's existing SQLite database into the
// new Postgres cluster.  Idempotent: safe to re-run; uses transactional
// truncate-then-import so partial failures roll back cleanly.
//
// Usage:
//   LEGACY_SQLITE_PATH=./server/data/food-hall.db \
//   DATABASE_URL=postgres://... \
//   npm run migrate-from-sqlite
//
// On App Platform:
//   1. Provision Managed Postgres
//   2. Run THIS SCRIPT locally with DATABASE_URL pointing at the cluster
//   3. App Platform service comes up, reads existing data, no seed runs

import 'dotenv/config';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────
const sqlitePath = process.env.LEGACY_SQLITE_PATH || './server/data/food-hall.db';
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite file not found at: ${sqlitePath}`);
  console.error('Set LEGACY_SQLITE_PATH or place the .db file at server/data/food-hall.db');
  process.exit(1);
}

console.log(`Source SQLite: ${path.resolve(sqlitePath)}`);
console.log(`Target Postgres: ${process.env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`);

const sqlite = new Database(sqlitePath, { readonly: true });
const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'disable' ? false
       : process.env.NODE_ENV === 'production' ? 'require'
       : 'prefer',
  max: 4,
});

// ── Detect target state and clean up if needed ───────────────
// Three possibilities:
//   A) Truly empty target  → apply schema, import
//   B) Tables exist but no data (e.g. a previous failed import)  → drop, re-apply, import
//   C) Tables exist WITH data  → refuse, require manual reset
const fhTables = [
  'adjustments', 'weekly_summaries', 'daily_calculations',
  'weekly_periods', 'audit_log', 'users', 'vendors', 'markets',
  'schema_migrations'
];
const existingRows = await sql`
  SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(${fhTables})
`;
const existingTables = existingRows.map(r => r.tablename);

if (existingTables.length > 0) {
  let hasData = false;
  for (const t of existingTables) {
    if (t === 'schema_migrations') continue;  // pre-seeded; not user data
    const [{ count }] = await sql.unsafe(`SELECT COUNT(*)::int AS count FROM ${t}`);
    if (count > 0) { hasData = true; break; }
  }
  if (hasData) {
    console.log('\n⚠️  Target database already has FoodHall data.');
    console.log('    To re-import, manually drop the tables first:');
    console.log(`      DROP TABLE IF EXISTS ${fhTables.join(', ')} CASCADE;`);
    await sql.end();
    process.exit(1);
  }
  console.log('\n[0/3] Found empty FoodHall tables from a prior failed run. Dropping for clean retry...');
  await sql.unsafe(`DROP TABLE IF EXISTS ${fhTables.join(', ')} CASCADE`);
  console.log('     dropped');
}

// ── Apply schema ────────────────────────────────────────────
console.log('\n[1/3] Applying Postgres schema...');
const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'schema.pg.sql'), 'utf8');
await sql.unsafe(schemaSql);
console.log('     schema applied');

// ── Helpers ─────────────────────────────────────────────────
const tables = [
  // order matters: parents before children
  'markets', 'vendors', 'users',
  'weekly_periods', 'daily_calculations',
  'weekly_summaries', 'adjustments',
  'audit_log',
];

// SQLite int-as-bool → Postgres bool conversion
const boolFields = {
  vendors: ['active', 'is_excluded'],
  users: ['active', 'must_change_password'],
  weekly_periods: ['is_linen_week'],
  daily_calculations: ['is_closure_day'],
};

// SQLite text-JSON → Postgres JSONB tag
const jsonbFields = {
  weekly_periods: ['closure_days'],
  audit_log: ['details'],
};

function transform(table, row) {
  const out = { ...row };
  for (const f of (boolFields[table] || [])) {
    if (out[f] !== null && out[f] !== undefined) out[f] = Boolean(out[f]);
  }
  // JSONB columns: SQLite stored as TEXT, Postgres wants the value as a
  // JS value that postgres.js will serialize. Pass through strings as-is —
  // they'll be cast at insert time using ::jsonb on the value.
  return out;
}

console.log('\n[2/3] Importing rows...');

await sql.begin(async (sql) => {
  for (const table of tables) {
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    if (rows.length === 0) {
      console.log(`     ${table.padEnd(22)} 0 rows (skip)`);
      continue;
    }

    const transformed = rows.map(r => transform(table, r));

    // Build the column list from the first row's keys (preserves order)
    const cols = Object.keys(transformed[0]);

    // For JSONB columns we need to cast at insert time. postgres.js doesn't
    // expose per-column casting cleanly when using sql(rows), so we do row-
    // by-row inserts when JSONB is involved. For all-other tables, use the
    // efficient batch helper.
    const hasJsonb = (jsonbFields[table] || []).length > 0;

    if (hasJsonb) {
      const jsonbCols = jsonbFields[table];
      for (const row of transformed) {
        // Build column/value pairs with JSONB casts inline
        const colExprs = cols.map(c => sql(c));
        const valExprs = cols.map(c => {
          if (jsonbCols.includes(c) && row[c] !== null && row[c] !== undefined) {
            return sql`${row[c]}::jsonb`;
          }
          return sql`${row[c]}`;
        });
        // sql.unsafe is unavoidable for dynamic column lists in postgres.js;
        // values stay parameterized.
        await sql.unsafe(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`,
          cols.map(c => {
            const v = row[c];
            if (jsonbCols.includes(c) && v !== null && v !== undefined) {
              return typeof v === 'string' ? v : JSON.stringify(v);
            }
            return v;
          })
        );
      }
    } else {
      // Bulk insert via sql(rows, ...cols)
      await sql`INSERT INTO ${sql(table)} ${sql(transformed, ...cols)}`;
    }

    // Reset the IDENTITY sequence to MAX(id)+1 so future inserts don't collide
    if (cols.includes('id')) {
      await sql.unsafe(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                       COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`
      );
    }

    console.log(`     ${table.padEnd(22)} ${rows.length} rows ✓`);
  }
});

console.log('\n[3/3] Verifying counts match...');
let allMatch = true;
for (const table of tables) {
  const src = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  const [{ count: dst }] = await sql.unsafe(`SELECT COUNT(*)::int AS count FROM ${table}`);
  const status = src === dst ? '✓' : '✗ MISMATCH';
  if (src !== dst) allMatch = false;
  console.log(`     ${table.padEnd(22)} sqlite=${src}  postgres=${dst}  ${status}`);
}

await sql.end();
sqlite.close();

if (allMatch) {
  console.log('\n✅ Import complete. Counts match across all tables.');
} else {
  console.log('\n❌ Import finished but some counts do not match. Investigate before deploying.');
  process.exit(1);
}
