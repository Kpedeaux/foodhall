# FoodHall — Security Audit (2026-05-15)

> White-box review of the FoodHall Node/Express application as deployed to DigitalOcean App Platform with Managed Postgres. Builds on the May 8 audit captured in `SECURITY.md`; explicitly audits the post-Postgres-migration state plus everything new the migration introduced.

## Executive summary

The app is in solid shape architecturally. SQL is fully parameterized via postgres.js tagged templates. Multi-tenant scoping by `market_id` is consistently applied across all 28 routes — no cross-tenant data leak via the API surface. Helmet, CORS allowlist, account lockout, and login rate limiting are in place.

There are, however, **two critical** issues that should be fixed before exposing this app to a second tenant or any wider audience: (1) an admin can reset *another admin's* password without consent or a re-auth challenge, which means one compromised admin account = all admin accounts in that market, and (2) the old Square production access token sits in the git history of `SECURITY.md` itself — if you didn't actually rotate it on May 8 it remains live forever. There are also several **high-severity** issues — refresh tokens cannot be revoked, mass-assignment on the user-update endpoint, synchronous bcrypt blocking the event loop, login timing leaks user existence, JWT verification without algorithm pinning, and a known ReDoS in the `path-to-regexp` transitive dep — that should be addressed this week.

The May 8 backlog (JWT in localStorage, native bcrypt async, equalized login timing, body limit, Excel formula injection, etc.) is still mostly unapplied. Most of those map directly to this audit's findings and should be folded into the same remediation pass.

## Threat model

| | |
|---|---|
| **Audience** | St. Roch Market today. Designed to onboard additional food halls as separate tenants. |
| **Users** | Per-market admins (Ashley + future), per-vendor accounts (read-only access to their own data). |
| **Exposure** | Public internet at https://foodhall-taady.ondigitalocean.app via DigitalOcean App Platform. |
| **Sensitive data** | Vendor weekly financials (sales, fees, payouts, balance carryover), admin/vendor credentials, Square production access token, signed audit log of every privileged action. |
| **Realistic attackers** | (1) random internet scanner hitting the public URL; (2) logged-in vendor attempting horizontal escalation to another vendor's financials; (3) compromised or rogue admin escalating within the market (e.g., reset Ashley's password, log in as her, manipulate payouts); (4) hypothetical future second-tenant admin attempting to read first-tenant data. |
| **Worst case** | Square access token leak → attacker reads every payment, order, and customer record across all 24 St. Roch Square locations. JWT secret leak → attacker forges admin tokens. Cross-tenant query leak → tenant-A admin sees tenant-B vendor financials, ending the multi-tenant SaaS pitch. |
| **Compensating controls in place** | Helmet headers, CORS allowlist, per-IP login limiter (10/15min), account lockout (5 failures → 30 min), JWT short access tokens (2h), `requireAdmin` on every admin route, parameterized SQL throughout, audit log of privileged actions, real-time session invalidation via DB active-flag check. |

## Scope

**In scope:**
- All server-side code under `server/` (28 routes, 12 files, ~2,400 LOC)
- Database schema (`server/db/schema.pg.sql`)
- Deployment configuration (App Platform env vars, Postgres user model, build commands)
- Dependency tree (npm audit, transitive vulnerabilities)
- Git history (committed secrets, branch hygiene)

**Out of scope (this round):**
- Frontend XSS / DOM-clobbering analysis on React UI
- Penetration testing against the live URL (white-box only)
- Square API back-end (we audit how WE use it, not Square itself)
- DigitalOcean platform-level posture (assumed sound)

## Findings by severity

### CRITICAL

#### C1 — Admin can reset any other admin's password

**File:** `server/routes/admin.js:476-498`

**CWE:** CWE-269 (Improper Privilege Management), CWE-863 (Incorrect Authorization)

**Description:**
`POST /api/admin/users/:id/reset-password` lets any user with the `admin` role set a new password for any other user in their market — including other admins. There is no check that the target is a non-admin, no re-authentication challenge for the calling admin, no notification to the target, no recovery path if the password change is unauthorized.

**Proof of exploitability:**
1. Attacker compromises a low-privilege admin account (phishing, credential reuse, etc.).
2. Calls `POST /api/admin/users/<ashley_user_id>/reset-password` with a body of `{"newPassword":"attacker-controlled-12chars"}`.
3. Logs in as Ashley with the new password. `must_change_password=TRUE` is set on Ashley, but the attacker holds the password anyway.
4. Attacker now has full admin authority, can read/modify every vendor's financials, approve weeks, etc.

**Impact:** One compromised admin = all admins. The blast radius of a credential theft is multiplied by the number of admins in the market. For a future multi-tenant deployment this is also the mechanism by which a compromised tenant-A admin's tooling could pivot to other admins in tenant A.

**Remediation:** Block admins from password-resetting other admins. Either: (a) only allow self password-resets via `/api/auth/change-password` and require the target to use the lost-password flow for their own reset, or (b) require a peer-admin to confirm the reset out-of-band, or (c) require re-entry of the calling admin's own password before any privileged user-management write. Minimum viable fix is option (a): return 403 if `target.role === 'admin' && target.id !== req.user.id`.

---

#### C2 — Square production access token in git history

**File:** `SECURITY.md` (committed, all history)

**CWE:** CWE-540 (Inclusion of Sensitive Information in Source Code)

**Description:**
The May 8 `SECURITY.md` document contains the literal Square production access token in its remediation instructions:

```
git log -S "<OLD_SQUARE_TOKEN>" --all
```

That string is a 64-character Square access token. It is committed to the repo, pushed to GitHub, and will exist in git history forever — even if the file is later edited. The repo is currently **public** (https://github.com/Kpedeaux/foodhall).

**Proof of exploitability:** Anyone who clones the repo and runs `git log -p SECURITY.md` sees the token. If it's still active on the Square account, `curl -H "Authorization: Bearer <token>" https://connect.squareup.com/v2/locations` returns every Square location, customer, payment, and order across all 24 St. Roch locations.

**Impact:** Depends entirely on whether you actually rotated this token after May 8 as instructed.
- **If rotated:** historical only, no live exposure. Reduce to LOW (repo hygiene).
- **If not rotated:** active, full Square data exfiltration risk.

**Remediation:**
1. **Verify rotation status immediately.** Log into Square Developer Dashboard, check the access token in use, confirm it's a different one than the string above.
2. If not rotated, rotate now: revoke the old token in Square's dashboard, generate a new one, update `SQUARE_ACCESS_TOKEN` in DigitalOcean App Platform's env vars (already encrypted), restart the app.
3. **Edit `SECURITY.md`** to remove the literal token from the example command (use a placeholder like `<OLD_TOKEN>`). Commit and push. The token will still be in history forever, but reduces casual visibility.
4. Consider `git filter-repo` to rewrite history removing the token from `SECURITY.md` entirely. This is destructive (rewrites all commits) and requires force-pushing — only worth it if the token is still live and you want belt-and-suspenders cleanup. Since GitHub caches forks/snapshots, this isn't a perfect remediation either.

---

### HIGH

#### H1 — Refresh tokens have no server-side revocation

**File:** `server/middleware/auth.js:85-95`, `server/routes/auth.js:87-117`

**CWE:** CWE-613 (Insufficient Session Expiration)

**Description:**
Refresh tokens are stateless JWTs signed with `JWT_SECRET`, valid for 7 days. The `POST /api/auth/refresh` route verifies the signature and exchanges for a fresh access token. There is no database table of issued refresh tokens, no revocation list, no rotation on use.

Consequences:
- If a refresh token is stolen (XSS, malware, leaked browser session, etc.), it remains valid for up to 7 days regardless of whether the user logs out.
- "Log out" is a frontend-only action — clearing local storage — but the server doesn't know the session is gone.
- An admin reset-password event doesn't invalidate the target user's existing refresh tokens. They keep working until expiry.

**Impact:** Stolen sessions persist beyond the user's awareness. Combined with C1, a compromised refresh token = unrevoked admin access for up to a week.

**Remediation:**
- Maintain a `refresh_tokens` table: `(jti UUID PRIMARY KEY, user_id, issued_at, expires_at, revoked_at, replaced_by_jti)`.
- Add a `jti` (JWT ID) claim to every refresh token at signing time. Store on issue, mark `revoked_at` on logout / password change / admin reset.
- On `/refresh`: look up `jti`, reject if revoked or expired.
- On successful refresh: rotate — issue a new `jti`, mark old one as `replaced_by_jti=new`. Detect reuse of an already-rotated `jti` as a stolen-session signal; revoke all sessions for that user.

---

#### H2 — Mass-assignment on `PUT /api/admin/users/:id` allows cross-market vendor reassignment

**File:** `server/routes/admin.js:453-474`

**CWE:** CWE-915 (Improperly Controlled Modification of Dynamically-Determined Object Attributes)

**Description:**
The update accepts `vendor_id` from the request body and writes it directly. The `WHERE` clause verifies the *user being edited* is in the admin's market, but nothing checks that the *new* `vendor_id` is also in the admin's market.

```js
const { username, email, active, vendor_id } = req.body;
await sql`UPDATE users SET ... vendor_id = ${vendor_id ?? user.vendor_id} ...
          WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}`;
```

**Proof of exploitability:**
1. Admin in market A queries `/api/admin/users` and gets the list of users in their market. Picks a vendor account.
2. PUTs `{ vendor_id: <some vendor ID from market B> }` to that user.
3. The user's JWT will now embed `vendor_id` from market B. When that user logs in (or refreshes their token), their session is partially scoped to market B's vendor.
4. Practical effect depends on what the JWT's `vendor_id` controls — for the vendor portal, it determines which vendor's weeks they can read. So a market-A vendor account can be redirected to read a market-B vendor's financials.

**Remediation:** Before the UPDATE, verify the supplied `vendor_id` is in the admin's market:

```js
if (vendor_id !== undefined && vendor_id !== null) {
  const [v] = await sql`SELECT id FROM vendors WHERE id = ${vendor_id} AND market_id = ${req.user.market_id}`;
  if (!v) return res.status(400).json({ error: 'vendor_id does not belong to your market' });
}
```

Apply the same pattern to `POST /api/admin/users` (line 413-451) and `PUT /api/admin/vendors/:id` (line 84-120) — the latter doesn't update `market_id`, but should defensively verify it can't be smuggled.

---

#### H3 — Synchronous bcrypt blocks the event loop during login

**File:** `server/routes/auth.js:44, 165`, `server/routes/admin.js:429, 489`

**CWE:** CWE-400 (Uncontrolled Resource Consumption)

**Description:**
Every login, password change, and admin user-create / password-reset uses `bcrypt.compareSync()` or `bcrypt.hashSync()`. At cost factor 12, each call takes 100–250ms of synchronous CPU time. During that interval, the Node event loop is **completely blocked** — no other request, health-check, audit-log write, or Postgres callback can run.

Concrete consequence on the 512 MB App Platform tier:
- 10 concurrent login attempts = 1–2.5 seconds of total event-loop block = the `/health` check times out = App Platform marks the container unhealthy = restart.
- An attacker doesn't need credentials to trigger this — failed logins go through `bcrypt.compare` against the stored hash (after the user-existence check) too.
- This is a built-in DoS amplifier. The login rate limit (10 attempts / 15 min per IP) caps it per IP, but a distributed attempt or a credential-stuffing pool defeats the limit.

**Remediation:** Swap `bcryptjs` for `bcrypt` (the native module, async API) — `npm uninstall bcryptjs && npm install bcrypt`. Then refactor:

```js
// Before:
const valid = bcrypt.compareSync(password, user.password_hash);
// After:
const valid = await bcrypt.compare(password, user.password_hash);
```

`bcrypt` (native) is also significantly faster than `bcryptjs` for the same cost factor, so latency drops as well as concurrency improves.

---

#### H4 — Login allows username enumeration via timing

**File:** `server/routes/auth.js:37-49`

**CWE:** CWE-203 (Observable Discrepancy)

**Description:**
When a username doesn't exist, the login route returns 401 immediately after the DB lookup. When it does exist, the request additionally runs `bcrypt.compareSync` (100–250ms) before returning the same 401 for a bad password. The response-time delta is reliable enough to enumerate valid usernames in seconds.

**Proof of exploitability:** `curl -w "%{time_total}\n" -d '{"username":"ashley","password":"x"}' ...` vs same with `"username":"nobody"`. The first takes ~250ms, the second ~10ms. Repeat across a wordlist of common usernames → known-valid accounts ready for credential stuffing.

**Remediation:** When the user is not found, still run a `bcrypt.compare` against a fixed pre-computed hash. Discard the result. Total response time equalizes across both paths.

```js
const DUMMY_HASH = '$2a$12$CkP6Ws/9ZQDBgQ4PmDQjkO/JsqXSx27GpKqUGz4VbE7Da0gQq3wga';
const [user] = await sql`SELECT ...`;
const hashToCheck = user ? user.password_hash : DUMMY_HASH;
const valid = await bcrypt.compare(password, hashToCheck);
if (!user || !valid) {
  // existing 401 path
}
```

---

#### H5 — JWT verification does not pin the algorithm

**File:** `server/middleware/auth.js:38, 90`

**CWE:** CWE-347 (Improper Verification of Cryptographic Signature)

**Description:**
```js
decoded = jwt.verify(token, JWT_SECRET);
```

No `algorithms` option is passed. The `jsonwebtoken` library at v9+ does enforce that the algorithm matches the secret type, so passing an `alg:none` token is rejected. But this is implicit, not explicit, and any library upgrade or downstream patch could change the default.

**Remediation:** Pin the algorithm explicitly:

```js
decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
```

Apply same change at line 90 (`verifyRefreshToken`).

---

#### H6 — `path-to-regexp` Regular Expression DoS (transitive)

**File:** `node_modules/path-to-regexp` (via `express@4.21.x`)

**CWE:** CWE-1333 (Inefficient Regular Expression Complexity), GHSA-1115527

**Description:**
`npm audit` flags one HIGH vulnerability in production deps: `path-to-regexp` (used by Express's routing layer) has a regex pattern that can be crafted to cause exponential backtracking. A malicious URL pattern compiled into a route can hang the event loop.

You don't compile arbitrary user-supplied route patterns, so this is mostly a defense-in-depth concern. But it's a known CVE in your hot path.

**Remediation:** Upgrade Express. `express@5.x` ships with the patched `path-to-regexp`. The upgrade is mostly transparent; the main breaking changes affect error-handling middleware signature and async route handlers — both of which your code already uses correctly. Test before deploying:

```cmd
npm install express@^5
npm run server   # smoke-test locally first
```

If the Express 5 migration is too disruptive right now, the alternative is a manual override:

```json
"overrides": {
  "path-to-regexp": "^6.3.0"
}
```

in `package.json`, then `npm install`.

---

#### H7 — Old `doadmin` Postgres password exposed in chat history

**File:** External (chat session 2026-05-13)

**CWE:** CWE-540 (Inclusion of Sensitive Information)

**Description:**
During the May 13 migration session, a screenshot of the DO Postgres cluster panel was shared with the `doadmin` password visible (redacted — see chat log of 2026-05-13). That string is now in the chat log. The chat log is stored on Anthropic's servers and visible to anyone with access to your account.

The current `doadmin` password may or may not have been rotated since — the user was advised to rotate but the rotation status wasn't confirmed.

**Impact:** Anyone with the password + a Trusted Source IP (currently your home IP `<your home IP, redacted>`) can connect as the Postgres superuser and dump every row in every database in the cluster. The future Manager Portal and Coffee Shop Portal databases will live in the same cluster.

**Remediation:**
1. Log into DO → Cluster → Users & Databases → click ⋯ next to `doadmin` → Reset password.
2. Update any tooling that uses doadmin (one-shot migration scripts on your laptop) with the new credentials.
3. App Platform's runtime uses `foodhall_app`, not `doadmin`, so no app reconfiguration is needed.
4. Consider deleting the `doadmin` user and using a less-privileged migration user going forward, though DO Managed Postgres requires doadmin for some operations so this may not be fully possible.

---

### MEDIUM

#### M1 — JWTs stored in browser `localStorage` (per May 8 backlog, still applicable)

**Frontend:** React app stores `token` and `refreshToken` accessible to any script running on the page.

**CWE:** CWE-922 (Insecure Storage of Sensitive Information)

**Impact:** Any XSS bug — including a vendor name containing a `<script>` tag rendered without escaping — extracts the access token AND refresh token. With H1 unfixed, the refresh token is a 7-day all-access pass.

**Remediation:** Migrate to `HttpOnly; Secure; SameSite=Strict` cookies for both tokens. Add a CSRF token on state-changing requests since SameSite alone isn't bulletproof for all scenarios. This is a meaningful refactor — frontend `apiFetch` wrapper and login flow change shape — defer if no XSS surface is currently active, but track as a tech-debt item.

---

#### M2 — Admin can deactivate self or other admins, locking the market out

**File:** `server/routes/admin.js:453-474`

**CWE:** CWE-269 (Improper Privilege Management)

**Description:** No check prevents an admin from setting `active=false` on their own row or on the last remaining admin in the market. A compromised admin can deactivate Ashley → effectively delete admin access. (Combined with H2, attacker can also cross-link their vendor_id and then deactivate other admins.)

**Remediation:** Reject the request if `req.params.id === req.user.id && active === false`. Additionally count remaining active admins before deactivation; reject if it would leave 0 admins in the market.

---

#### M3 — Excel formula injection in `exporter.js` (per May 8 backlog)

**File:** `server/services/exporter.js` — every `addRow` with vendor data

**CWE:** CWE-1236 (Improper Neutralization of Formula Elements in a CSV File)

**Description:** Vendor names, week dates, and descriptions are written to xlsx cells without sanitization. If an admin creates a vendor named `=cmd|'/c calc'!A1`, that string lands in a CPA's spreadsheet and executes on open (depending on Excel version and macro settings).

**Remediation:** Prefix any cell value starting with `=`, `+`, `-`, `@`, tab, or carriage-return with a single quote `'` to force literal interpretation. Wrapper:

```js
function safeCell(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
```

Apply to every user-influenced cell write.

---

#### M4 — 10MB JSON body limit is excessive

**File:** `server/index.js:50`

**CWE:** CWE-770 (Allocation of Resources Without Limits)

**Description:** `express.json({ limit: '10mb' })`. The largest legitimate body is a few KB (admin user creation, adjustment). 10MB lets an attacker burn memory parsing junk.

**Remediation:** Lower to 100KB: `express.json({ limit: '100kb' })`. Add a per-route override only if a specific endpoint legitimately needs more.

---

#### M5 — Error messages leak Postgres internals to client

**File:** `server/routes/admin.js:80, 117, 118, 449`; `server/index.js:96-104`

**CWE:** CWE-209 (Information Exposure Through Error Messages)

**Description:** Routes catch errors and return `err.message` directly to the client. Postgres errors include schema, table, column, constraint names. Useful for development, useful-but-different for an attacker.

**Remediation:** Log the full error server-side, return a generic message to the client:

```js
} catch (err) {
  console.error('POST /vendors failed:', err);
  res.status(400).json({ error: 'Failed to create vendor' });
}
```

Optional: add a top-level error wrapper that returns generic messages in production and the real text in dev based on `NODE_ENV`.

---

#### M6 — `auditLog(... req.body)` can record sensitive fields

**File:** `server/routes/admin.js:115, 471, 523` (and similar)

**CWE:** CWE-532 (Insertion of Sensitive Information into Log)

**Description:** Several admin routes log the entire `req.body` to `audit_log.details`. If a client accidentally includes a `password` field in a PUT user request, the password gets persisted to the audit log in plaintext.

The `create_user` handler (line 446) correctly logs only `{username, role}`. Other handlers don't.

**Remediation:** Always whitelist the fields to log:

```js
await auditLog(req.user.market_id, req.user.id, 'update_user', 'user', req.params.id, {
  username: req.body.username,
  email: req.body.email,
  active: req.body.active,
  vendor_id: req.body.vendor_id,
});
```

Never pass raw `req.body` to the audit log.

---

#### M7 — GET `/api/<unknown>` returns React index.html instead of 404

**File:** `server/index.js:78-80, 86-88`

**CWE:** CWE-451 (Misrepresentation of UI / Incorrect API behavior)

**Description:** Route order: `/api/auth`, `/api/admin`, `/api/vendor`, `/api/export` are registered first. Then the SPA fallback `app.get('*')` for the React frontend. *Then* the `/api` 404 catch-all. The SPA fallback matches first, so a GET to `/api/nonexistent` returns the HTML SPA. A POST/PUT/DELETE correctly returns the 404 JSON.

**Remediation:** Move the `/api` 404 BEFORE the SPA fallback. Or scope the SPA fallback to non-`/api` paths:

```js
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(...));
```

---

#### M8 — `recalcNetTransfer` does not enforce market scope

**File:** `server/routes/admin.js:375-393`

**CWE:** CWE-639 (Authorization Bypass Through User-Controlled Key) — defense-in-depth

**Description:** The function takes a `weeklySummaryId` and operates without verifying it belongs to the caller's market. It's currently only called from `/adjustments` POST and DELETE, both of which check market scope before calling. **Today this is safe.** But future code paths that call `recalcNetTransfer` could inadvertently skip the check.

**Remediation:** Pass `marketId` into `recalcNetTransfer` and filter every query by it. Cost is one extra arg; benefit is the function becomes safe in isolation.

---

#### M9 — `brace-expansion` ReDoS (transitive dep)

**Reference:** GHSA-1115540, GHSA-1115541

**Description:** Used by `glob` / `minimatch` / various build tooling. Exploitability in your runtime is essentially zero — it's hit during dev/build, not request handling. Filing as informational for completeness.

**Remediation:** Will resolve via standard `npm update` over time.

---

### LOW

#### L1 — `req.params.id` not validated as integer before use

**File:** Most admin routes (e.g., `admin.js:87, 142, 250, 273, 293, 353, 456, 479`)

**Description:** Postgres-side cast catches non-integer values, but the error is returned to the client (M5 applies). Defense-in-depth: validate as positive integer first.

```js
const id = Number(req.params.id);
if (!Number.isInteger(id) || id <= 0) {
  return res.status(400).json({ error: 'Invalid id' });
}
```

---

#### L2 — HSTS not asserted at application level

**Description:** Relies on App Platform's load balancer to enforce HTTPS. App Platform does redirect HTTP → HTTPS by default for `*.ondigitalocean.app` and adds HSTS. Defense-in-depth: enable Helmet's HSTS explicitly:

```js
app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  ...
}));
```

---

#### L3 — Long-lived refresh tokens (7 days) without rotation

**Description:** Industry norm but combined with H1, a stolen refresh token = 7-day all-access. Mitigated significantly once H1 is fixed (rotation + revocation). Consider lowering to 24h once refresh-on-use rotation is in place.

---

#### L4 — Stale `vite.config.js.timestamp-*.mjs` files committed

**Description:** Six Vite cache shim files in repo root. Not security-relevant, just clutter. Already in updated `.gitignore` going forward; existing copies need to be `git rm`'d.

---

#### L5 — Legacy SQLite scripts committed but inoperable

**File:** `inspect-admins.cjs`, `scripts/reset-demo-passwords.cjs`, `scripts/rotate-secrets.cjs`, `server/db/seed-demo.js`, `server/db/seed-demo-week.js`

**Description:** All tagged with `// LEGACY (SQLite-era)` on line 1, but still in the repo. Not a vulnerability — anyone running them locally just gets a connect error. Worth keeping as historical reference, or moving to `legacy/` subdir for clarity.

---

### INFORMATIONAL

#### I1 — Pending hardening backlog from May 8 still applies

The bullets at the bottom of `SECURITY.md` are mostly still open work. This audit's H3, H4, M1, M2, M3, M4, and L2 are all already on that backlog. Treat as confirmation, not new findings.

#### I2 — `better-sqlite3` retained as devDep for the import script

Will harmlessly compile during `npm install --include=dev` on App Platform deploys. Not a security issue. If you want to drop it entirely, move `scripts/import-sqlite-to-postgres.mjs` to a separate `migration-scripts/` package or delete after the migration is fully done.

#### I3 — `CORS_ORIGINS` hard-coded to single domain

Will need updating when a custom domain is added. Currently fine.

#### I4 — Schema GRANTs hard-code `foodhall_app` username

**File:** `server/db/schema.pg.sql` (last block)

The GRANT block in the schema file targets a user named `foodhall_app` literally. If you ever change the runtime user name (or for the Manager Portal / Coffee Shop Portal migrations, where you'll create `manager_app` / `coffee_app` users), update accordingly or templatize.

---

## What this app gets right (don't lose these)

- **SQL is 100% parameterized via postgres.js tagged templates.** No `sql.unsafe()` anywhere with user input. SQL injection is structurally precluded.
- **Multi-tenant scoping is consistent.** Every read and write through admin/vendor routes includes `WHERE market_id = ${req.user.market_id}`. No cross-tenant data leak via the API.
- **Account lockout** (`middleware/lockout.js`) — 5 failures, 30-min lock, DB-backed (survives restarts).
- **Per-IP login rate limiting** with `skipSuccessfulRequests` so legitimate users aren't accidentally throttled.
- **Real-time session invalidation:** every authenticated request re-checks `active` flag in the DB. Deactivated users can't keep using existing tokens.
- **Refresh-token-as-access-token guard** (`middleware/auth.js:47-49`) — explicitly rejects refresh tokens used in the Bearer header.
- **Schema isolation by runtime user:** `foodhall_app` has CRUD but not DDL on `public`. App can't accidentally drop tables.
- **Helmet, CORS allowlist, JWT refusal on missing secret in production** — solid baseline hardening.
- **Comprehensive audit log** — every privileged action goes to `audit_log` with actor, action, and entity.
- **Forced password change on first login** via `must_change_password` flag in seed.
- **No webhooks defined** = no webhook-signature-verification gap.

## Appendix A — npm audit summary

Production dependencies:
- 1 HIGH: `path-to-regexp` (transitive via Express 4) — covered as H6.
- 3 MODERATE: `brace-expansion` (M9), `express-rate-limit` / `ip-address` (XSS in unused method, low practical exploit risk).
- 0 critical, 0 low.

Dev dependencies adds 3 more moderate (`esbuild`, `postcss`, `vite`) — none affect production runtime.

## Appendix B — files audited

```
server/index.js
server/db/database.js
server/db/schema.pg.sql
server/middleware/auth.js
server/middleware/lockout.js
server/middleware/passwordPolicy.js
server/middleware/rateLimiter.js
server/routes/admin.js
server/routes/auth.js
server/routes/vendors.js
server/routes/export.js
server/services/calculator.js
server/services/exporter.js
server/services/square.js
package.json
.env.example
.gitignore
SECURITY.md
scripts/import-sqlite-to-postgres.mjs
```

Total: 19 files, ~2,400 LOC of server-side application logic. Frontend not audited in this pass.

---

*Audit complete. See `SECURITY-FIXES-2026-05-15.md` for the actionable remediation checklist.*
