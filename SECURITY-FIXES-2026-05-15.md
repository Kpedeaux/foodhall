# FoodHall — Remediation Checklist (2026-05-15)

> Companion to `SECURITY-AUDIT-2026-05-15.md`. Work top-to-bottom. Severity tag + estimated effort (S = <1h, M = a few hours, L = a day or more) appears on each item.

## Today (criticals — block any wider rollout until done)

- [ ] **C2 — Verify Square token rotation status.** [S]
  Log into Square Developer Dashboard, confirm the current production token is NOT `EAAAl-CeHmm...` (the one in `SECURITY.md`'s git history). If it IS, rotate it now, then update `SQUARE_ACCESS_TOKEN` in App Platform's env vars.

- [ ] **C2 — Scrub the token from `SECURITY.md`.** [S]
  Replace the literal token string in the `git log -S` example with `<OLD_TOKEN>` or remove the example entirely. Commit and push. (Cannot remove from history without `git filter-repo` — only worth that if the token is still live.)

- [ ] **C1 — Block admins from resetting other admins' passwords.** [S]
  `server/routes/admin.js:476-498` (`POST /api/admin/users/:id/reset-password`):
  ```js
  if (user.role === 'admin' && user.id !== req.user.id) {
    return res.status(403).json({ error: 'Admins cannot reset other admins\' passwords. The target admin must use the lost-password flow.' });
  }
  ```
  After this fix, an admin who needs to change their own password uses `/api/auth/change-password` (existing route, requires current password).

- [ ] **H7 — Rotate the `doadmin` Postgres password.** [S]
  DO → Cluster → Users & Databases → ⋯ next to `doadmin` → Reset password. The runtime app uses `foodhall_app` so no app reconfig needed.

## This week (highs — practical exploit risk)

- [ ] **H1 — Add server-side refresh token revocation + rotation.** [M]
  - Add migration: create `refresh_tokens` table with `(jti UUID PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, issued_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, replaced_by_jti UUID)`.
  - Update `signRefreshToken` (`server/middleware/auth.js:85`) to include a `jti` claim and INSERT a row.
  - Update `POST /api/auth/refresh` (`server/routes/auth.js:87`) to look up the `jti`, reject if `revoked_at IS NOT NULL` or expired, rotate (insert new with `replaced_by_jti` pointing at it), mark old as revoked.
  - Detect reused-revoked-jti as a token-theft signal: revoke all sessions for that user when seen.
  - Add a logout endpoint `POST /api/auth/logout` that revokes the calling session's `jti`.
  - On admin password reset (C1 fix above) and self password change: revoke ALL existing refresh tokens for the target user.

- [ ] **H2 — Validate `vendor_id` belongs to the admin's market in user-update.** [S]
  `server/routes/admin.js:453-474` (`PUT /api/admin/users/:id`) — add a verification before the UPDATE:
  ```js
  if (vendor_id !== undefined && vendor_id !== null) {
    const [v] = await sql`SELECT id FROM vendors WHERE id = ${vendor_id} AND market_id = ${req.user.market_id}`;
    if (!v) return res.status(400).json({ error: 'vendor_id does not belong to your market' });
  }
  ```
  Also add to `POST /api/admin/users` (line 413-451). Also add a strict body allowlist so unrelated fields like `role`, `market_id`, `password_hash`, `failed_login_attempts` can't be smuggled.

- [ ] **H3 — Replace `bcryptjs` with native `bcrypt`, switch to async API.** [M]
  - `npm uninstall bcryptjs && npm install bcrypt`
  - Change all `bcrypt.compareSync` / `bcrypt.hashSync` to `await bcrypt.compare` / `await bcrypt.hash`. Affected files: `server/routes/auth.js:44, 165, 171`, `server/routes/admin.js:429, 489`, `server/db/database.js:138`.
  - Run `npm rebuild` on first App Platform deploy (native module compiles for the platform's Node version).
  - Smoke-test login locally before pushing.

- [ ] **H4 — Equalize login timing with a dummy bcrypt comparison.** [S]
  `server/routes/auth.js:37-49`. After H3 is done, refactor login to always run `bcrypt.compare` against a fixed dummy hash if the user doesn't exist:
  ```js
  const DUMMY_HASH = '$2b$12$....'; // generate one once, paste here
  const hashToCheck = user ? user.password_hash : DUMMY_HASH;
  const valid = await bcrypt.compare(password, hashToCheck);
  if (!user || !valid) { /* existing 401 path */ }
  ```

- [ ] **H5 — Pin JWT algorithm explicitly.** [S]
  `server/middleware/auth.js:38, 90`:
  ```js
  decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  ```

- [ ] **H6 — Patch `path-to-regexp` ReDoS.** [S–M]
  Path A (smaller blast radius): pin via `package.json` `overrides`:
  ```json
  "overrides": { "path-to-regexp": "^6.3.0" }
  ```
  then `npm install`. Re-run `npm audit` to confirm the high goes away.
  
  Path B (cleaner long-term): upgrade Express to v5 — `npm install express@^5`. Express 5 ships with patched path-to-regexp and brings async error-handling improvements that fit our codebase. Smoke-test all 28 routes after the upgrade.

## This month (mediums — hardening)

- [ ] **M1 — Move JWTs out of `localStorage` into `HttpOnly` cookies.** [L]
  Sets cookies server-side instead of returning tokens in JSON. Frontend `apiFetch` wrapper changes to `credentials: 'include'`. Add CSRF token middleware on POST/PUT/DELETE. Significant refactor; sequence after H1.

- [ ] **M2 — Prevent admin self-deactivation and last-admin-standing.** [S]
  `server/routes/admin.js:453-474`. Reject if `req.params.id === req.user.id && active === false`. Also count active admins in market; reject deactivation if it would leave 0.

- [ ] **M3 — Sanitize Excel exports against formula injection.** [S]
  `server/services/exporter.js`. Add a `safeCell` helper that prefixes any string starting with `=`, `+`, `-`, `@`, tab, or CR with a single quote. Wrap every user-influenced `addRow` value.

- [ ] **M4 — Lower JSON body limit from 10MB to 100KB.** [S]
  `server/index.js:50`: `app.use(express.json({ limit: '100kb' }))`.

- [ ] **M5 — Stop returning Postgres error messages to clients.** [S]
  Replace `err.message` with generic messages in routes that catch errors. Server-side `console.error` keeps the detail. Affected: `server/routes/admin.js:80, 117, 118, 449`; `server/index.js:96-104` (global handler — gate detail on `NODE_ENV !== 'production'`).

- [ ] **M6 — Stop logging raw `req.body` to `audit_log`.** [S]
  Whitelist the fields to log on each update. Affected: `admin.js:115, 471, 523`.

- [ ] **M7 — Fix SPA fallback shadowing `/api` 404.** [S]
  `server/index.js:78-80`. Replace `app.get('*', ...)` with a path-scoped regex:
  ```js
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  ```
  Or move the `/api` 404 handler above the SPA fallback.

- [ ] **M8 — Pass `marketId` into `recalcNetTransfer`.** [S]
  `server/routes/admin.js:375-393`. Add parameter, filter every query by it. Defense-in-depth against future call sites.

## When convenient (lows + cleanup)

- [ ] **L1 — Validate `req.params.id` as positive integer at every route.** [S]
  Add a small middleware:
  ```js
  function requireIntParam(name) {
    return (req, res, next) => {
      const v = Number(req.params[name]);
      if (!Number.isInteger(v) || v <= 0) return res.status(400).json({ error: `Invalid ${name}` });
      req.params[name] = v;
      next();
    };
  }
  ```
  Apply to every `:id` route.

- [ ] **L2 — Enable Helmet HSTS explicitly.** [S]
  `server/index.js:21-24`. App Platform already adds HSTS but defense-in-depth is cheap.

- [ ] **L3 — Shorten refresh token lifetime to 24h** once H1 rotation is in place. [S]
  `server/middleware/auth.js:24`.

- [ ] **L4 — `git rm` stale Vite timestamp files.** [S]
  ```cmd
  git rm vite.config.js.timestamp-*.mjs
  git commit -m "Remove stale Vite cache shims"
  ```

- [ ] **L5 — Move legacy SQLite scripts to `legacy/` subdirectory** [S]
  ```cmd
  mkdir legacy
  git mv inspect-admins.cjs scripts/reset-demo-passwords.cjs scripts/rotate-secrets.cjs legacy/
  ```
  Or delete if you're sure you'll never need them.

## Verification after each batch

After landing each tier of fixes, run:

```cmd
npm audit
npm run server   :: smoke-test locally with .env pointed at DO Postgres
```

Then `git push` — App Platform autodeploys. Test on the live URL.

## Regression tests worth writing

Once H1-H7 land, add at minimum these integration tests so the fixes can't be undone silently:

1. `POST /api/admin/users/:adminId/reset-password` as another admin → expect 403.
2. `PUT /api/admin/users/:vendorUserId` with `vendor_id` from another market → expect 400.
3. Login as nonexistent user vs. wrong password — measure response times, expect within 50ms of each other.
4. After password change, old refresh token → expect 401 on `/api/auth/refresh`.
5. Use a refresh token twice (replay) — expect second use to revoke ALL of the user's sessions.

---

*Total: 2 criticals, 7 highs, 9 mediums, 5 lows. Suggested order: today → this week → this month → backlog.*
