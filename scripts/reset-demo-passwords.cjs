// LEGACY (SQLite-era): not converted to Postgres yet. Do not run against the new Postgres DB.
/**
 * One-shot: rotate the demo-admin / demo-vendor account passwords to fresh
 * random values. The new passwords are printed to stdout ONCE. Copy them
 * into your password manager — they cannot be recovered later.
 *
 *   node scripts/reset-demo-passwords.cjs
 *
 * Why this exists: the demo accounts (demo-admin / demo-vendor) ship with
 * a public default password (`demo1234`). On a publicly-exposed deploy,
 * that's effectively no password at all. This script sets each demo
 * account to a 24-char random alphanumeric password.
 */
"use strict";

const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const DB_PATH = path.join(__dirname, "..", "server", "data", "food-hall.db");

/** Cryptographically random alphanumeric of length n. */
function randomPassword(len = 24) {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"; // no 0/O/1/l/I
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const db = new Database(DB_PATH, { fileMustExist: true });

const targets = [
  { username: "demo-admin", role: "admin" },
  { username: "demo-vendor", role: "vendor" },
];

const update = db.prepare(
  "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE username = ?",
);

console.log("");
console.log("FoodHall — rotating demo-account passwords");
console.log("==========================================");
console.log("");
console.log(
  "Copy these into your password manager NOW. They will not be shown again.",
);
console.log("");

for (const t of targets) {
  const exists = db
    .prepare("SELECT id, username FROM users WHERE username = ?")
    .get(t.username);
  if (!exists) {
    console.log(`  [skip] ${t.username} — no user with that username`);
    continue;
  }
  const newPassword = randomPassword(24);
  const hash = bcrypt.hashSync(newPassword, 12);
  update.run(hash, t.username);
  console.log(`  ${t.username}  (id=${exists.id})`);
  console.log(`    password: ${newPassword}`);
  console.log("");
}

console.log("Done. The demo-admin and demo-vendor accounts no longer accept");
console.log('the public default "demo1234".');
console.log("");

db.close();