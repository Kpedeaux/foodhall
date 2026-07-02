import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { sql } from '../db/database.js';

// ── JWT Secret ──────────────────────────────────────────────
// NEVER fall back to a hardcoded string in production.
// Generate a random secret on first run if not set, but warn loudly.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('╔══════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: JWT_SECRET environment variable is not set.     ║');
    console.error('║  Set JWT_SECRET before running in production.           ║');
    console.error('║  Generate one: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))" ║');
    console.error('╚══════════════════════════════════════════════════════════╝');
    process.exit(1);
  }
  // Development only: generate a random per-run secret (tokens won't survive restarts)
  JWT_SECRET = crypto.randomBytes(64).toString('hex');
  console.warn('⚠️  No JWT_SECRET set — using random secret (dev mode only). Tokens reset on restart.');
} else if (JWT_SECRET.length < 48) {
  // A secret IS set but is short/low-entropy. The recommended value is 64
  // random bytes as hex (128 chars). A short, human-typed passphrase is
  // brute-forcible offline, which would let an attacker forge admin/super
  // tokens without ever touching the login endpoint. Warn loudly but do not
  // crash — refusing to boot could lock a live deployment out of itself.
  console.warn(
    `⚠️  JWT_SECRET is only ${JWT_SECRET.length} characters — below the recommended strength. ` +
    'Generate a strong one with:  node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"  ' +
    'then set it in your production environment. (Rotating it logs everyone out; they simply re-login.)'
  );
}

const ACCESS_TOKEN_EXPIRY = '2h';     // Short-lived access token
const REFRESH_TOKEN_EXPIRY = '7d';    // Longer-lived refresh token

// JWT algorithm we sign with. Pinned on every verify (H5 — 2026-05-15 audit)
// to guard against library regressions or downgrade attacks.
const JWT_ALG = 'HS256';

// ── Authenticate middleware ─────────────────────────────────
// Verifies JWT AND checks that the user is still active in the database.
// This closes the gap where a deactivated user's token still works.
export async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  let decoded;
  try {
    const token = authHeader.split(' ')[1];
    // H5 (2026-05-15 audit): pin the algorithm explicitly.
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALG] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Reject refresh tokens used as access tokens
  if (decoded.type === 'refresh') {
    return res.status(401).json({ error: 'Invalid token type' });
  }

  try {
    // Real-time session invalidation: verify user is still active. Also pull
    // the LIVE must_change_password flag (not the token's stale copy) so the
    // requirePasswordChanged gate below can enforce it server-side.
    const [user] = await sql`SELECT active, must_change_password FROM users WHERE id = ${decoded.id}`;
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Account deactivated' });
    }

    req.user = { ...decoded, must_change_password: !!user.must_change_password }; // { id, username, role, market_id, vendor_id, must_change_password }
    next();
  } catch (err) {
    next(err);
  }
}

// ── Role guards ─────────────────────────────────────────────
export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export function requireVendor(req, res, next) {
  if (req.user.role !== 'vendor') {
    return res.status(403).json({ error: 'Vendor access required' });
  }
  next();
}

export function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin access required' });
  }
  next();
}

// ── Force-password-change gate ──────────────────────────────
// When an admin resets a user's password, the account is left with a
// temporary credential and must_change_password = TRUE. The React app
// redirects such users to the change-password screen, but that guard is
// client-side only — before this gate, the temporary password worked against
// every API endpoint (curl/Postman) indefinitely. Mount this on the
// privileged routers (admin/vendor/super/export) AFTER authenticate. The auth
// router does NOT mount it, so /api/auth/change-password and /api/auth/me
// remain reachable so the user can actually clear the flag.
export function requirePasswordChanged(req, res, next) {
  if (req.user && req.user.must_change_password) {
    return res.status(403).json({
      error: 'You must change your temporary password before using the app.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
  next();
}

// ── Token signing ───────────────────────────────────────────
export function signAccessToken(payload) {
  return jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, {
    algorithm: JWT_ALG,
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
}

export function signRefreshToken(payload) {
  return jwt.sign({ id: payload.id, type: 'refresh' }, JWT_SECRET, {
    algorithm: JWT_ALG,
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
}

export function verifyRefreshToken(token) {
  // H5 (2026-05-15 audit): pin the algorithm explicitly.
  const decoded = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALG] });
  if (decoded.type !== 'refresh') {
    throw new Error('Not a refresh token');
  }
  return decoded;
}

// Keep backward compat alias
export function signToken(payload) {
  return signAccessToken(payload);
}
