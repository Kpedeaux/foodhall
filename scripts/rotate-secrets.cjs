// LEGACY (SQLite-era): not converted to Postgres yet. Do not run against the new Postgres DB.
/**
 * Generate a fresh JWT_SECRET for FoodHall.
 *
 * Run:    node scripts/rotate-secrets.cjs
 * Output: env-style key=value line for you to paste into .env.
 *
 * Rotating JWT_SECRET invalidates every existing access + refresh token.
 * Every user will be logged out and will have to sign in again.
 *
 * What this does NOT rotate:
 *   - SQUARE_ACCESS_TOKEN (rotate in the Square Developer Dashboard:
 *     https://developer.squareup.com/apps -> revoke -> reissue, then
 *     update SQUARE_ACCESS_TOKEN in .env).
 */
"use strict";

const crypto = require("crypto");

const secret = crypto.randomBytes(64).toString("hex");

console.log(`# --- Rotated on ${new Date().toISOString()} ---`);
console.log(`JWT_SECRET=${secret}`);
console.log("");
console.log("# Paste into .env, replacing the existing JWT_SECRET line.");
console.log(
  "# Restart the server. Every user will need to sign in again.",
);
console.log(
  "# Square access token MUST be rotated separately in the Square dashboard.",
);