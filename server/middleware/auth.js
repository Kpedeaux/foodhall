import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getDb } from '../db/database.js';

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
}

const ACCESS_TOKEN_EXPIRY = '2h';     // Short-lived access token
const REFRESH_TOKEN_EXPIRY = '7d';    // Longer-lived refresh token

// ── Authenticate middleware ─────────────────────────────────
// Verifies JWT AND checks that the user is still active in the database.
// This closes the gap where a deactivated user's token still works.
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Reject refresh tokens used as access tokens
    if (decoded.type === 'refresh') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    // Real-time session invalidation: verify user is still active
    const db = getDb();
    const user = db.prepare('SELECT active FROM users WHERE id = ?').get(decoded.id);
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Account deactivated' });
    }

    req.user = decoded; // { id, username, role, market_id, vendor_id }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid or expired token' });
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

// ── Token signing ───────────────────────────────────────────
export function signAccessToken(payload) {
  return jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export function signRefreshToken(payload) {
  return jwt.sign({ id: payload.id, type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

export function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.type !== 'refresh') {
    throw new Error('Not a refresh token');
  }
  return decoded;
}

// Keep backward compat alias
export function signToken(payload) {
  return signAccessToken(payload);
}
