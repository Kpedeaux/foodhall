import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { sql, auditLog } from '../db/database.js';
import { authenticate, signAccessToken, signRefreshToken, verifyRefreshToken } from '../middleware/auth.js';
import { loginLimiter, passwordLimiter } from '../middleware/rateLimiter.js';
import { checkLockout, recordFailedAttempt, resetFailedAttempts } from '../middleware/lockout.js';
import { validatePassword } from '../middleware/passwordPolicy.js';

const router = Router();

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Check account lockout BEFORE doing any password work
    const lockStatus = await checkLockout(username);
    if (lockStatus.locked) {
      await auditLog(null, null, 'login_locked', 'user', null,
        { username, ip: req.ip, minutesLeft: lockStatus.minutesLeft });
      return res.status(423).json({
        error: `Account is temporarily locked. Try again in ${lockStatus.minutesLeft} minutes.`,
      });
    }

    const [user] = await sql`
      SELECT u.*, v.name AS vendor_name
      FROM users u
      LEFT JOIN vendors v ON u.vendor_id = v.id
      WHERE LOWER(u.username) = LOWER(${username}) AND u.active = TRUE
    `;

    if (!user) {
      // Log failed attempt (don't reveal whether user exists)
      await auditLog(null, null, 'login_failed', 'user', null,
        { username, ip: req.ip, reason: 'user_not_found' });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      await recordFailedAttempt(username);
      await auditLog(user.market_id, user.id, 'login_failed', 'user', user.id,
        { ip: req.ip, reason: 'bad_password' });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Success — reset lockout counter
    await resetFailedAttempts(user.id);

    const tokenPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      market_id: user.market_id,
      vendor_id: user.vendor_id,
    };

    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    await auditLog(user.market_id, user.id, 'login', 'user', user.id, { ip: req.ip });

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
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh — exchange a refresh token for a new access token
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Verify user is still active
    const [user] = await sql`
      SELECT u.id, u.username, u.role, u.market_id, u.vendor_id, u.active
      FROM users u
      WHERE u.id = ${decoded.id} AND u.active = TRUE
    `;

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
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const [user] = await sql`
      SELECT u.id, u.username, u.role, u.market_id, u.vendor_id,
             u.must_change_password, v.name AS vendor_name
      FROM users u
      LEFT JOIN vendors v ON u.vendor_id = v.id
      WHERE u.id = ${req.user.id} AND u.active = TRUE
    `;

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
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, passwordLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    // Enforce password policy
    const policy = validatePassword(newPassword);
    if (!policy.valid) {
      return res.status(400).json({ error: policy.errors.join('. ') });
    }

    const [user] = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;

    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    const valid = bcrypt.compareSync(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Use higher bcrypt cost for financial data
    const hash = bcrypt.hashSync(newPassword, 12);
    await sql`
      UPDATE users
      SET password_hash = ${hash}, must_change_password = FALSE
      WHERE id = ${user.id}
    `;

    await auditLog(user.market_id, user.id, 'change_password', 'user', user.id, null);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
