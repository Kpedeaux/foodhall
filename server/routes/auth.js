import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb, auditLog } from '../db/database.js';
import { authenticate, signAccessToken, signRefreshToken, verifyRefreshToken } from '../middleware/auth.js';
import { loginLimiter, passwordLimiter } from '../middleware/rateLimiter.js';
import { checkLockout, recordFailedAttempt, resetFailedAttempts } from '../middleware/lockout.js';
import { validatePassword } from '../middleware/passwordPolicy.js';

const router = Router();

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  // Check account lockout BEFORE doing any password work
  const lockStatus = checkLockout(username);
  if (lockStatus.locked) {
    auditLog(null, null, 'login_locked', 'user', null,
      JSON.stringify({ username, ip: req.ip, minutesLeft: lockStatus.minutesLeft }));
    return res.status(423).json({
      error: `Account is temporarily locked. Try again in ${lockStatus.minutesLeft} minutes.`,
    });
  }

  const db = getDb();
  const user = db.prepare(`
    SELECT u.*, v.name as vendor_name
    FROM users u
    LEFT JOIN vendors v ON u.vendor_id = v.id
    WHERE LOWER(u.username) = LOWER(?) AND u.active = 1
  `).get(username);

  if (!user) {
    // Log failed attempt (don't reveal whether user exists)
    auditLog(null, null, 'login_failed', 'user', null,
      JSON.stringify({ username, ip: req.ip, reason: 'user_not_found' }));
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    recordFailedAttempt(username);
    auditLog(user.market_id, user.id, 'login_failed', 'user', user.id,
      JSON.stringify({ ip: req.ip, reason: 'bad_password' }));
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Success — reset lockout counter
  resetFailedAttempts(user.id);

  const tokenPayload = {
    id: user.id,
    username: user.username,
    role: user.role,
    market_id: user.market_id,
    vendor_id: user.vendor_id,
  };

  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);

  auditLog(user.market_id, user.id, 'login', 'user', user.id,
    JSON.stringify({ ip: req.ip }));

  res.json({
    token: accessToken,         // backward compat — frontend uses "token"
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      market_id: user.market_id,
      vendor_id: user.vendor_id,
      vendor_name: user.vendor_name,
      must_change_password: !!user.must_change_password,
    },
  });
});

// POST /api/auth/refresh — exchange a refresh token for a new access token
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);

    // Verify user is still active
    const db = getDb();
    const user = db.prepare(`
      SELECT u.id, u.username, u.role, u.market_id, u.vendor_id, u.active
      FROM users u WHERE u.id = ? AND u.active = 1
    `).get(decoded.id);

    if (!user) {
      return res.status(401).json({ error: 'Account deactivated or not found' });
    }

    const newAccessToken = signAccessToken({
      id: user.id,
      username: user.username,
      role: user.role,
      market_id: user.market_id,
      vendor_id: user.vendor_id,
    });

    res.json({ token: newAccessToken });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT u.id, u.username, u.role, u.market_id, u.vendor_id, u.must_change_password, v.name as vendor_name
    FROM users u
    LEFT JOIN vendors v ON u.vendor_id = v.id
    WHERE u.id = ? AND u.active = 1
  `).get(req.user.id);

  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    market_id: user.market_id,
    vendor_id: user.vendor_id,
    vendor_name: user.vendor_name,
    must_change_password: !!user.must_change_password,
  });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, passwordLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }

  // Enforce password policy
  const policy = validatePassword(newPassword);
  if (!policy.valid) {
    return res.status(400).json({ error: policy.errors.join('. ') });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!user) {
    return res.status(400).json({ error: 'User not found' });
  }

  const valid = bcrypt.compareSync(currentPassword, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  // Use higher bcrypt cost for financial data
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);

  auditLog(user.market_id, user.id, 'change_password', 'user', user.id, null);

  res.json({ success: true });
});

export default router;
