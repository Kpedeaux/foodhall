# Security — FoodHall

> Living document. Update on every change to auth, secrets, exposure, or
> incident-response procedure. Last reviewed: 2026-05-08.

## Threat model

| | |
|---|---|
| **Audience** | St. Roch Market — internal vendor-revenue-sharing portal. |
| **Users** | Market admins (Ashley, etc.), outside food-hall vendors. Vendor accounts have read access to their own week summaries. |
| **Exposure** | Public internet via Cloudflare Tunnel (`vendorportal.creativecorerail.com`) today. |
| **Sensitive data** | Vendor business financials (sales, percentages, daily rent), audit log, Square production access token (server-side only). |
| **Worst-case** | Square token leak → attacker reads every payment, order, and customer record across all 24 of your Square locations. JWT secret leak → attacker mints an admin token and reassigns vendor records. |
| **Compensating controls** | Helmet, CORS allowlist, account lockout, per-IP rate limit, server-side `requireAdmin` on all admin routes, parameterized SQL throughout. |

## Stop-work fixes already applied (2026-05-08)

| ID | Change | File |
|---|---|---|
| B | Removed hardcoded `ashley` / `changeme` seed; first-boot admin creation now requires `INITIAL_ADMIN_PASSWORD` env var (12+ chars, must not be a known default). | `server/db/database.js` |

## Things you must do (operator action required)

1. **Rotate the Square production access token NOW.** It has been visible in `.env` and is treated as compromised. Procedure:
   - Open https://developer.squareup.com/apps → your application → "OAuth" tab.
   - Revoke the existing access token.
   - Issue a new one (or, better, switch to OAuth code-grant with refresh — see "Pending hardening").
   - Update `SQUARE_ACCESS_TOKEN` in `.env`.
   - Restart the server.

2. **Rotate the JWT secret:**
   ```
   node scripts/rotate-secrets.cjs
   ```
   Paste the output into `.env`, restart. Every user will be logged out and must sign in again.

3. **Run the read-only admin inspection** to confirm no live account is still on the seeded `changeme` password:
   ```
   node inspect-admins.cjs
   ```
   If any account flags `*** YES ***` in the seed-default column, change its password immediately by logging in as that user via the UI (you'll be forced to change on first login — `must_change_password` is set in the seed). If the live `ashley` account predates this fix and `must_change_password` is `0`, an admin must reset it via `Admin → Users → Reset Password`.

4. **Verify `.env` was never committed:**
   ```
   git log --all --full-history -- .env
   git log -S "<OLD_SQUARE_TOKEN_REDACTED>" --all
   ```

5. **Verify your CoreRail folder is not synced to OneDrive/iCloud/Dropbox.** If it is, the Square token has been to the cloud.

## Secrets layout

| Secret | Source | Rotation impact | Rotate via |
|---|---|---|---|
| `JWT_SECRET` | `.env` | All access + refresh tokens invalidated; every user logged out. | `scripts/rotate-secrets.cjs` |
| `SQUARE_ACCESS_TOKEN` | `.env` | Square pull breaks until token replaced. | Square Developer Dashboard → revoke + reissue → update `.env`. |
| `INITIAL_ADMIN_PASSWORD` | `.env` (one-time) | Used only on first boot when DB is empty. Remove from `.env` after first successful login. | n/a |

## Pending hardening (high-impact tier — not yet applied)

These are tracked in the ongoing security backlog. Address before any new exposure expansion.

- **Move JWTs out of `localStorage`** into `HttpOnly; Secure; SameSite=Strict` cookies; add explicit CSRF tokens on writes.
- **Switch from `bcryptjs` (sync, JS) to `bcrypt` (native, async)**; rewrite the login path to be non-blocking. Currently every login holds the event loop for ~100-250ms — concurrent logins are a built-in DoS amplifier.
- **Equalize login timing** — when the user is not found, run a dummy `bcrypt.compare` against a fixed hash so timing doesn't reveal valid usernames.
- **Tighten `PUT /api/admin/users/:id`** with a strict body allowlist; prevent admins from deactivating themselves; validate `vendor_id` belongs to the caller's market.
- **Configure `trust proxy` correctly** for Cloudflare Tunnel and use `CF-Connecting-IP` for rate-limit keys (currently every request looks like 127.0.0.1, so the rate limiter is a single shared bucket).
- **Lower `express.json` body limit** from 10MB to ~100KB.
- **Sanitize Excel cells in exports** to prevent formula-injection (`=`, `+`, `-`, `@` prefix in vendor names becomes a payload when a CPA opens the file).
- **OAuth code-grant + refresh tokens** for Square (replaces long-lived static access token).
- **Tighten CSP** in production to remove `'unsafe-inline'` for styles.

## Incident response

If you suspect a credential leak or unauthorized access:

1. **Immediately** stop the Cloudflare Tunnel for `vendorportal.creativecorerail.com` so the app is unreachable.
2. Rotate `JWT_SECRET` (`node scripts/rotate-secrets.cjs`) — invalidates all tokens.
3. Rotate the Square access token in the Square Developer Dashboard.
4. Inspect the audit log for the suspect window:
   ```
   sqlite3 server/data/food-hall.db "SELECT timestamp, user_id, action, entity_type, entity_id FROM audit_log ORDER BY id DESC LIMIT 200;"
   ```
5. Reset every admin password via the UI; force `must_change_password=1` on every active user with a SQL UPDATE if needed:
   ```
   sqlite3 server/data/food-hall.db "UPDATE users SET must_change_password=1 WHERE active=1;"
   ```
6. Notify vendors. Their financial data is in scope.
7. Restart and bring the tunnel back up.

## Operator quick reference

- Audit roster: `node inspect-admins.cjs`
- Rotate JWT secret: `node scripts/rotate-secrets.cjs`
- View recent audit: `sqlite3 server/data/food-hall.db "SELECT * FROM audit_log ORDER BY id DESC LIMIT 50;"`
- First-boot setup: set `INITIAL_ADMIN_PASSWORD=...` in `.env`, then `npm start`.
