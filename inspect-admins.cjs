// LEGACY (SQLite-era): not converted to Postgres yet. Do not run against the new Postgres DB.
/**
 * READ-ONLY admin inspection for FoodHall.
 *
 * Lists every user, flags admins, checks whether any password still matches
 * the seeded default `changeme`. Does not change anything.
 *
 *   node inspect-admins.cjs
 */
"use strict";

const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const DB_PATH = path.join(__dirname, "server", "data", "food-hall.db");
const SEED_PASSWORD = "changeme";

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const users = db
  .prepare(
    `SELECT id, market_id, username, email, role, active,
            must_change_password, password_hash, created_at
       FROM users
       ORDER BY id ASC`,
  )
  .all();

console.log(`\nFoodHall — ${users.length} user(s) in ${DB_PATH}\n`);
console.log(
  "id  | role  | active | must_change | username        | email                          | seed-default? | created_at",
);
console.log(
  "----+-------+--------+-------------+-----------------+--------------------------------+----------------+--------------------",
);

let defaultsFound = 0;
for (const u of users) {
  let usingDefault = false;
  try {
    usingDefault = bcrypt.compareSync(SEED_PASSWORD, u.password_hash);
  } catch {
    /* malformed hash — leave false */
  }
  if (usingDefault) defaultsFound++;
  console.log(
    [
      String(u.id).padEnd(3),
      String(u.role || "").padEnd(5),
      (u.active === 1 ? "yes" : "no").padEnd(6),
      (u.must_change_password === 1 ? "yes" : "no").padEnd(11),
      String(u.username || "").padEnd(15),
      String(u.email || "").padEnd(30),
      (usingDefault ? "*** YES ***" : "no").padEnd(14),
      u.created_at || "",
    ].join(" | "),
  );
}

console.log("");
if (defaultsFound > 0) {
  console.log(
    `*** ALERT: ${defaultsFound} account(s) still using the seeded default password "${SEED_PASSWORD}". Change immediately. ***`,
  );
} else {
  console.log("OK: no accounts are using the seeded default password.");
}
console.log("");

db.close();