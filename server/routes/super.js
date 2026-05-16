import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { sql, auditLog } from '../db/database.js';
import { validatePassword } from '../middleware/passwordPolicy.js';

const router = Router();
router.use(authenticate, requireSuperAdmin);

// ============================================================
// Markets
// ============================================================

router.get('/markets', async (req, res, next) => {
  try {
    const markets = await sql`
      SELECT
        m.*,
        (SELECT COUNT(*)::int FROM users  WHERE market_id = m.id) AS user_count,
        (SELECT COUNT(*)::int FROM users  WHERE market_id = m.id AND role = 'admin'  AND active = TRUE) AS active_admin_count,
        (SELECT COUNT(*)::int FROM users  WHERE market_id = m.id AND role = 'vendor' AND active = TRUE) AS active_vendor_user_count,
        (SELECT COUNT(*)::int FROM vendors WHERE market_id = m.id AND active = TRUE) AS active_vendor_count,
        (SELECT MAX(week_start)  FROM weekly_periods WHERE market_id = m.id) AS last_week_start,
        (SELECT MAX(week_start)  FROM weekly_periods WHERE market_id = m.id AND status = 'approved') AS last_approved_week_start
      FROM markets m
      ORDER BY m.id
    `;
    res.json(markets);
  } catch (err) { next(err); }
});

router.post('/markets', async (req, res, next) => {
  try {
    const { name, square_environment, default_delivery_fee_rate, default_service_charge_rate } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    const env = square_environment === 'sandbox' ? 'sandbox' : 'production';
    const [row] = await sql`
      INSERT INTO markets (name, square_environment, default_delivery_fee_rate, default_service_charge_rate)
      VALUES (
        ${name.trim()},
        ${env},
        ${Number.isFinite(default_delivery_fee_rate)  ? default_delivery_fee_rate  : 0.105},
        ${Number.isFinite(default_service_charge_rate) ? default_service_charge_rate : 0.02}
      )
      RETURNING id
    `;
    await auditLog(null, req.user.id, 'super_create_market', 'market', row.id, { name: name.trim(), env });
    res.json({ id: row.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/markets/:id', async (req, res, next) => {
  try {
    const [market] = await sql`SELECT * FROM markets WHERE id = ${req.params.id}`;
    if (!market) return res.status(404).json({ error: 'Market not found' });

    const [{ count: vendor_count }] = await sql`SELECT COUNT(*)::int AS count FROM vendors WHERE market_id = ${market.id}`;
    const [{ count: active_vendor_count }] = await sql`SELECT COUNT(*)::int AS count FROM vendors WHERE market_id = ${market.id} AND active = TRUE`;
    const [{ count: week_count }] = await sql`SELECT COUNT(*)::int AS count FROM weekly_periods WHERE market_id = ${market.id}`;
    const [{ count: approved_week_count }] = await sql`SELECT COUNT(*)::int AS count FROM weekly_periods WHERE market_id = ${market.id} AND status = 'approved'`;

    res.json({ ...market, vendor_count, active_vendor_count, week_count, approved_week_count });
  } catch (err) { next(err); }
});

router.put('/markets/:id', async (req, res, next) => {
  try {
    const [market] = await sql`SELECT * FROM markets WHERE id = ${req.params.id}`;
    if (!market) return res.status(404).json({ error: 'Market not found' });

    const { name, default_delivery_fee_rate, default_service_charge_rate, square_environment } = req.body;

    await sql`
      UPDATE markets SET
        name = ${name ?? market.name},
        default_delivery_fee_rate = ${default_delivery_fee_rate ?? market.default_delivery_fee_rate},
        default_service_charge_rate = ${default_service_charge_rate ?? market.default_service_charge_rate},
        square_environment = ${square_environment ?? market.square_environment}
      WHERE id = ${market.id}
    `;

    await auditLog(market.id, req.user.id, 'super_update_market', 'market', market.id, {
      name, default_delivery_fee_rate, default_service_charge_rate, square_environment,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Vendors in a market — read-only
router.get('/markets/:id/vendors', async (req, res, next) => {
  try {
    const vendors = await sql`
      SELECT id, name, plan_type, percentage_rate, daily_base_rent, active, departed_date, is_excluded
      FROM vendors
      WHERE market_id = ${req.params.id}
      ORDER BY name
    `;
    res.json(vendors);
  } catch (err) { next(err); }
});

// Recent weeks in a market — read-only
router.get('/markets/:id/weeks', async (req, res, next) => {
  try {
    const weeks = await sql`
      SELECT id, week_start, week_end, status, is_linen_week, approved_at, calculated_at
      FROM weekly_periods
      WHERE market_id = ${req.params.id}
      ORDER BY week_start DESC
      LIMIT 26
    `;
    res.json(weeks);
  } catch (err) { next(err); }
});

// ============================================================
// Users (cross-market provisioning + password reset)
// ============================================================

router.get('/markets/:id/users', async (req, res, next) => {
  try {
    const users = await sql`
      SELECT u.id, u.username, u.email, u.role, u.active, u.must_change_password, u.created_at,
             v.name AS vendor_name
        FROM users u
        LEFT JOIN vendors v ON u.vendor_id = v.id
        WHERE u.market_id = ${req.params.id}
        ORDER BY u.role, u.username
    `;
    res.json(users);
  } catch (err) { next(err); }
});

router.post('/markets/:id/users', async (req, res, next) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    const policy = validatePassword(password);
    if (!policy.valid) return res.status(400).json({ error: policy.errors.join('. ') });

    const [m] = await sql`SELECT id FROM markets WHERE id = ${req.params.id}`;
    if (!m) return res.status(404).json({ error: 'Market not found' });

    const hash = bcrypt.hashSync(password, 12);
    try {
      const [row] = await sql`
        INSERT INTO users (market_id, username, password_hash, role, email, must_change_password)
        VALUES (${m.id}, ${username}, ${hash}, 'admin', ${email || null}, TRUE)
        RETURNING id
      `;
      await auditLog(m.id, req.user.id, 'super_create_admin', 'user', row.id, { username });
      res.json({ id: row.id });
    } catch (err) {
      if (err.code === '23505') return res.status(400).json({ error: 'Username already exists' });
      throw err;
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const [user] = await sql`SELECT * FROM users WHERE id = ${req.params.id}`;
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Super admin can reset admin and vendor passwords across any market,
    // but cannot reset OTHER super admins (each super admin manages their own
    // credentials). They can reset their own via the standard change-password
    // flow which requires the current password.
    if (user.role === 'super_admin' && user.id !== req.user.id) {
      return res.status(403).json({
        error: "Cannot reset another super admin's password. They must use the change-password flow themselves.",
      });
    }

    const { newPassword } = req.body;
    const policy = validatePassword(newPassword);
    if (!policy.valid) return res.status(400).json({ error: policy.errors.join('. ') });

    const hash = bcrypt.hashSync(newPassword, 12);
    await sql`
      UPDATE users SET
        password_hash = ${hash},
        must_change_password = TRUE,
        failed_login_attempts = 0,
        locked_until = NULL
      WHERE id = ${user.id}
    `;

    await auditLog(user.market_id, req.user.id, 'super_reset_password', 'user', user.id, null);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.put('/users/:id/active', async (req, res, next) => {
  try {
    const [user] = await sql`SELECT * FROM users WHERE id = ${req.params.id}`;
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.role === 'super_admin' && user.id !== req.user.id) {
      return res.status(403).json({ error: 'Cannot deactivate another super admin.' });
    }

    const active = req.body.active === true;
    await sql`UPDATE users SET active = ${active} WHERE id = ${user.id}`;

    await auditLog(user.market_id, req.user.id, 'super_set_active', 'user', user.id, { active });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// Cross-market summary
// ============================================================

router.get('/summary', async (req, res, next) => {
  try {
    const [row] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM markets) AS market_count,
        (SELECT COUNT(*)::int FROM users   WHERE role = 'admin'      AND active = TRUE) AS active_admin_count,
        (SELECT COUNT(*)::int FROM users   WHERE role = 'vendor'     AND active = TRUE) AS active_vendor_user_count,
        (SELECT COUNT(*)::int FROM vendors WHERE active = TRUE) AS active_vendor_count,
        (SELECT COUNT(*)::int FROM weekly_periods WHERE status = 'approved') AS approved_weeks,
        (SELECT COUNT(*)::int FROM weekly_periods WHERE status = 'draft')    AS draft_weeks
    `;
    res.json(row);
  } catch (err) { next(err); }
});

export default router;
