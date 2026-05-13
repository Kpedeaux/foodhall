import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const pg = await PGlite.create();
const server = new PGLiteSocketServer({ db: pg, port: 5434, host: '127.0.0.1' });
await server.start();

process.env.DATABASE_URL = 'postgres://postgres:@127.0.0.1:5434/template1';
process.env.DATABASE_SSL = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'a'.repeat(64);

await pg.exec(`CREATE TABLE t (id serial primary key, details jsonb)`);

const { sql, auditLog } = await import('./server/db/database.js');

const obj = { foo: 'bar', n: 42 };
// Direct postgres.js insert with cast
await sql`INSERT INTO t (details) VALUES (${JSON.stringify(obj)}::jsonb)`;
const [r1] = await sql`SELECT * FROM t WHERE id = 1`;
console.log('direct ::jsonb insert  → typeof details:', typeof r1.details, '  value:', r1.details);

// Without cast (text → jsonb implicit coercion)
await sql`INSERT INTO t (details) VALUES (${JSON.stringify(obj)})`;
const [r2] = await sql`SELECT * FROM t WHERE id = 2`;
console.log('no cast (sent as text) → typeof details:', typeof r2.details, '  value:', r2.details);

// Pass the object directly — postgres.js may JSON-encode it
await sql`INSERT INTO t (details) VALUES (${sql.json(obj)})`;
const [r3] = await sql`SELECT * FROM t WHERE id = 3`;
console.log('via sql.json(obj)      → typeof details:', typeof r3.details, '  value:', r3.details);

// Check what oid pglite reports for the jsonb column on read
const r4 = await sql`SELECT details FROM t WHERE id = 1`;
console.log('raw rows:', JSON.stringify(r4, null, 2));

await sql.end();
await server.stop();
