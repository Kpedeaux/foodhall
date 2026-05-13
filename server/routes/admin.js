import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { getDb, auditLog } from '../db/database.js';
import bcrypt from 'bcryptjs';
import { listLocations } from '../services/square.js';
import { calculateTransfersForWeek } from '../services/calculator.js';
import { validatePassword } from '../middleware/passwordPolicy.js';

const router = Router();
router.use(authenticate, requireAdmin);

// ============================================================
// Square Locations
// ============================================================

router.get('/square/locations', async (req, res) => {
  try {
    const locations = await listLocations();
    res.json(locations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Vendor Management
// ============================================================

router.get('/vendors', async (req, res) => {
  const db = getDb();
  const vendors = db.prepare('SELECT * FROM vendors WHERE market_id = ? ORDER BY name').all(req.user.market_id);

  // Also get unconfigured Square locations (skip for non-production markets like demo)
  let unconfigured = [];
  const market = db.prepare('SELECT square_environment FROM markets WHERE id = ?').get(req.user.market_id);
  if (market && market.square_environment === 'production') {
    try {
      const locations = await listLocations();
      const mappedIds = new Set(vendors.filter(v => v.square_location_id).map(v => v.square_location_id));
      unconfigured = locations.filter(l => !mappedIds.has(l.id)).map(l => ({ id: l.id, name: l.name }));
    } catch {
      // Square not connected — that's fine
    }
  }

  res.json({ vendors, unconfigured });
});

router.post('/vendors', (req, res) => {
  const db = getDb();
  const { name, square_location_id, plan_type, percentage_rate, daily_base_rent,
    delivery_fee_rate, service_charge_rate, weekly_minimum, linen_charge, active, departed_date, is_excluded } = req.body;

  try {
    const result = db.prepare(`
      INSERT INTO vendors (market_id, name, square_location_id, plan_type, percentage_rate, daily_base_rent,
        delivery_fee_rate, service_charge_rate, weekly_minimum, linen_charge, active, departed_date, is_excluded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.market_id, name, square_location_id || null,
      plan_type || 'STANDARD', percentage_rate ?? 0.30, daily_base_rent ?? 0,
      delivery_fee_rate ?? 0.105, service_charge_rate ?? 0.02,
      weekly_minimum ?? 0, linen_charge ?? 0, active ?? 1, departed_date || null, is_excluded ?? 0
    );

    auditLog(req.user.market_id, req.user.id, 'create_vendor', 'vendor', result.lastInsertRowid, req.body);
    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/vendors/:id', (req, res) => {
  const db = getDb();
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ? AND market_id = ?').get(req.params.id, req.user.market_id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

  const { name, square_location_id, plan_type, percentage_rate, daily_base_rent,
    delivery_fee_rate, service_charge_rate, weekly_minimum, linen_charge, active, departed_date, is_excluded } = req.body;

  try {
    db.prepare(`
      UPDATE vendors SET name = ?, square_location_id = ?, plan_type = ?, percentage_rate = ?,
        daily_base_rent = ?, delivery_fee_rate = ?, service_charge_rate = ?, weekly_minimum = ?,
        linen_charge = ?, active = ?, departed_date = ?, is_excluded = ?, updated_at = datetime('now')
      WHERE id = ? AND market_id = ?
    `).run(
      name ?? vendor.name, square_location_id ?? vendor.square_location_id,
      plan_type ?? vendor.plan_type, percentage_rate ?? vendor.percentage_rate,
      daily_base_rent ?? vendor.daily_base_rent, delivery_fee_rate ?? vendor.delivery_fee_rate,
      service_charge_rate ?? vendor.service_charge_rate, weekly_minimum ?? vendor.weekly_minimum,
      linen_charge ?? vendor.linen_charge, active ?? vendor.active,
      departed_date !== undefined ? (departed_date || null) : vendor.departed_date,
      is_excluded ?? vendor.is_excluded,
      req.params.id, req.user.market_id
    );

    auditLog(req.user.market_id, req.user.id, 'update_vendor', 'vendor', req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// Weekly Periods
// ============================================================

router.get('/weeks', (req, res) => {
  const db = getDb();
  const weeks = db.prepare(`
    SELECT wp.*, u.username as approved_by_username
    FROM weekly_periods wp
    LEFT JOIN users u ON wp.approved_by = u.id
    WHERE wp.market_id = ?
    ORDER BY wp.week_start DESC
  `).all(req.user.market_id);

  res.json(weeks);
});

router.get('/weeks/:id', (req, res) => {
  const db = getDb();
  const week = db.prepare('SELECT * FROM weekly_periods WHERE id = ? AND market_id = ?').get(req.params.id, req.user.market_id);
  if (!week) return res.status(404).json({ error: 'Week not found' });

  const summaries = db.prepare(`
    SELECT ws.*, v.name as vendor_name, v.plan_type, v.percentage_rate, v.daily_base_rent
    FROM weekly_summaries ws
    JOIN vendors v ON ws.vendor_id = v.id
    WHERE ws.weekly_period_id = ?
    ORDER BY v.name
  `).all(week.id);

  // Get daily calculations for each vendor
  const dailyCalcs = db.prepare(`
    SELECT dc.*, v.name as vendor_name
    FROM daily_calculations dc
    JOIN vendors v ON dc.vendor_id = v.id
    WHERE dc.weekly_period_id = ?
    ORDER BY v.name, dc.date
  `).all(week.id);

  // Get adjustments for each summary
  const adjustments = db.prepare(`
    SELECT a.*, ws.vendor_id
    FROM adjustments a
    JOIN weekly_summaries ws ON a.weekly_summary_id = ws.id
    WHERE ws.weekly_period_id = ?
    ORDER BY a.created_at
  `).all(week.id);

  // Group daily calcs by vendor
  const dailyByVendor = {};
  for (const dc of dailyCalcs) {
    if (!dailyByVendor[dc.vendor_id]) dailyByVendor[dc.vendor_id] = [];
    dailyByVendor[dc.vendor_id].push(dc);
  }

  // Group adjustments by vendor
  const adjByVendor = {};
  for (const adj of adjustments) {
    if (!adjByVendor[adj.vendor_id]) adjByVendor[adj.vendor_id] = [];
    adjByVendor[adj.vendor_id].push(adj);
  }

  // Calculate grand totals
  const grandTotals = {
    totalSales: 0, totalMarketFees: 0, totalDeliveryFees: 0,
    totalSquareFees: 0, totalCash: 0, totalTransfers: 0,
    totalTips: 0, totalLinenCharges: 0,
  };

  const vendorSummaries = summaries.map(s => {
    grandTotals.totalSales += s.total_sales;
    grandTotals.totalMarketFees += s.total_market_fee;
    grandTotals.totalDeliveryFees += s.delivery_fee;
    grandTotals.totalSquareFees += s.total_square_fees;
    grandTotals.totalCash += s.total_cash;
    grandTotals.totalTransfers += s.net_transfer;
    grandTotals.totalTips += s.tips_to_transfer;
    grandTotals.totalLinenCharges += s.linen_charge;

    return {
      ...s,
      days: dailyByVendor[s.vendor_id] || [],
      adjustments: adjByVendor[s.vendor_id] || [],
    };
  });

  // Round grand totals
  for (const key of Object.keys(grandTotals)) {
    grandTotals[key] = Math.round(grandTotals[key] * 100) / 100;
  }

  res.json({ week, vendors: vendorSummaries, grandTotals });
});

// Pre-flight check: confirm Square is reachable BEFORE the destructive
// recalculation runs. If Square is down or the token is misconfigured
// we want to fail fast with a clear error, not mid-way through a pull.
async function assertSquareReachable() {
  try {
    await listLocations();
  } catch (err) {
    const msg = err?.message || String(err);
    throw Object.assign(new Error(`Square is not reachable: ${msg}`), { status: 502 });
  }
}

// Pull Square data and calculate
router.post('/weeks/pull', async (req, res, next) => {
  const { weekStart, isLinenWeek, closureDays } = req.body;
  if (!weekStart) return res.status(400).json({ error: 'weekStart required' });

  try {
    await assertSquareReachable();
    const result = await calculateTransfersForWeek(req.user.market_id, weekStart, !!isLinenWeek, req.user.id, closureDays || []);
    res.json(result);
  } catch (err) {
    console.error('Transfer calculation error:', err);
    // Pass to global handler so the response is always JSON.
    next(err);
  }
});

// Recalculate a draft week (re-pull from Square)
router.post('/weeks/:id/recalculate', async (req, res, next) => {
  const db = getDb();
  const week = db.prepare('SELECT * FROM weekly_periods WHERE id = ? AND market_id = ?').get(req.params.id, req.user.market_id);
  if (!week) return res.status(404).json({ error: 'Week not found' });
  if (week.status !== 'draft') return res.status(400).json({ error: 'Can only recalculate draft weeks' });

  try {
    await assertSquareReachable();
    const savedClosureDays = JSON.parse(week.closure_days || '[]');
    const closureDays = req.body.closureDays || savedClosureDays;
    const result = await calculateTransfersForWeek(req.user.market_id, week.week_start, !!week.is_linen_week, req.user.id, closureDays);
    res.json(result);
  } catch (err) {
    console.error('Recalculate error:', err);
    next(err);
  }
});

// Approve a week
router.post('/weeks/:id/approve', (req, res) => {
  const db = getDb();
  const week = db.prepare('SELECT * FROM weekly_periods WHERE id = ? AND market_id = ?').get(req.params.id, req.user.market_id);
  if (!week) return res.status(404).json({ error: 'Week not found' });
  if (week.status !== 'draft') return res.status(400).json({ error: 'Week is already approved' });

  db.prepare(`
    UPDATE weekly_periods SET status = 'approved', approved_by = ?, approved_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id, week.id);

  auditLog(req.user.market_id, req.user.id, 'approve_week', 'weekly_period', week.id, { week_start: week.week_start });
  res.json({ success: true });
});

// Unlock an approved week
router.post('/weeks/:id/unlock', (req, res) => {
  const db = getDb();
  const week = db.prepare('SELECT * FROM weekly_periods WHERE id = ? AND market_id = ?').get(req.params.id, req.user.market_id);
  if (!week) return res.status(404).json({ error: 'Week not found' });
  if (week.status !== 'approved') return res.status(400).json({ error: 'Week is not approved' });

  db.prepare(`
    UPDATE weekly_periods SET status = 'draft', approved_by = NULL, approved_at = NULL
    WHERE id = ?
  `).run(week.id);

  auditLog(req.user.market_id, req.user.id, 'unlock_week', 'weekly_period', week.id, { week_start: week.week_start });
  res.json({ success: true });
});

// ============================================================
// Adjustments
// ============================================================

router.post('/adjustments', (req, res) => {
  const db = getDb();
  const { weekly_summary_id, type, amount, description } = req.body;

  // Verify the summary belongs to this market
  const summary = db.prepare(`
    SELECT ws.*, wp.market_id, wp.status
    FROM weekly_summaries ws
    JOIN weekly_periods wp ON ws.weekly_period_id = wp.id
    WHERE ws.id = ?
  `).get(weekly_summary_id);

  if (!summary || summary.market_id !== req.user.market_id) {
    return res.status(404).json({ error: 'Summary not found' });
  }
  if (summary.status !== 'draft') {
    return res.status(400).json({ error: 'Cannot modify adjustments on approved weeks' });
  }

  const result = db.prepare(`
    INSERT INTO adjustments (weekly_summary_id, type, amount, description, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(weekly_summary_id, type, amount, description, req.user.id);

  // Recalculate net_transfer
  recalcNetTransfer(weekly_summary_id);

  auditLog(req.user.market_id, req.user.id, 'add_adjustment', 'adjustment', result.lastInsertRowid, { type, amount, description });
  res.json({ id: result.lastInsertRowid });
});

router.delete('/adjustments/:id', (req, res) => {
  const db = getDb();

  const adj = db.prepare(`
    SELECT a.*, ws.id as summary_id, wp.market_id, wp.status
    FROM adjustments a
    JOIN weekly_summaries ws ON a.weekly_summary_id = ws.id
    JOIN weekly_periods wp ON ws.weekly_period_id = wp.id
    WHERE a.id = ?
  `).get(req.params.id);

  if (!adj || adj.market_id !== req.user.market_id) {
    return res.status(404).json({ error: 'Adjustment not found' });
  }
  if (adj.status !== 'draft') {
    return res.status(400).json({ error: 'Cannot modify adjustments on approved weeks' });
  }

  db.prepare('DELETE FROM adjustments WHERE id = ?').run(req.params.id);
  recalcNetTransfer(adj.summary_id);

  auditLog(req.user.market_id, req.user.id, 'delete_adjustment', 'adjustment', req.params.id, null);
  res.json({ success: true });
});

// Adjustments use signed amounts (accounting convention):
//   positive = credit to vendor (adds to transfer)
//   negative = fine/deduction (subtracts from transfer)
// So adjustments are ADDED to gross_transfer here.
function recalcNetTransfer(weeklySummaryId) {
  const db = getDb();
  const adjs = db.prepare('SELECT SUM(amount) as total FROM adjustments WHERE weekly_summary_id = ?').get(weeklySummaryId);
  const totalAdj = adjs.total || 0;

  const summary = db.prepare('SELECT gross_transfer, prior_balance_due FROM weekly_summaries WHERE id = ?').get(weeklySummaryId);
  const priorBalance = summary.prior_balance_due || 0;
  const netTransfer = Math.round((summary.gross_transfer + totalAdj - priorBalance) * 100) / 100;
  const balanceDue = netTransfer < 0 ? Math.round(Math.abs(netTransfer) * 100) / 100 : 0;

  db.prepare('UPDATE weekly_summaries SET net_transfer = ?, balance_due = ? WHERE id = ?').run(netTransfer, balanceDue, weeklySummaryId);
}

// ============================================================
// User Management
// ============================================================

router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.username, u.role, u.email, u.active, u.vendor_id, u.must_change_password, u.created_at,
           v.name as vendor_name
    FROM users u
    LEFT JOIN vendors v ON u.vendor_id = v.id
    WHERE u.market_id = ?
    ORDER BY u.role, u.username
  `).all(req.user.market_id);

  res.json(users);
});

router.post('/users', (req, res) => {
  const db = getDb();
  const { username, password, role, vendor_id, email } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  // Enforce password policy on new user creation
  const policy = validatePassword(password);
  if (!policy.valid) {
    return res.status(400).json({ error: policy.errors.join('. ') });
  }
  if (role === 'vendor' && !vendor_id) {
    return res.status(400).json({ error: 'Vendor accounts must be linked to a vendor' });
  }

  try {
    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare(`
      INSERT INTO users (market_id, username, password_hash, role, vendor_id, email, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(req.user.market_id, username, hash, role || 'vendor', vendor_id || null, email || null);

    auditLog(req.user.market_id, req.user.id, 'create_user', 'user', result.lastInsertRowid, { username, role });
    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    res.status(400).json({ error: err.message });
  }
});

router.put('/users/:id', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND market_id = ?').get(req.params.id, req.user.market_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { username, email, active, vendor_id } = req.body;

  db.prepare(`
    UPDATE users SET username = ?, email = ?, active = ?, vendor_id = ?
    WHERE id = ? AND market_id = ?
  `).run(
    username ?? user.username, email ?? user.email,
    active ?? user.active, vendor_id ?? user.vendor_id,
    req.params.id, req.user.market_id
  );

  auditLog(req.user.market_id, req.user.id, 'update_user', 'user', req.params.id, req.body);
  res.json({ success: true });
});

router.post('/users/:id/reset-password', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND market_id = ?').get(req.params.id, req.user.market_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { newPassword } = req.body;
  const policy = validatePassword(newPassword);
  if (!policy.valid) {
    return res.status(400).json({ error: policy.errors.join('. ') });
  }

  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, user.id);

  auditLog(req.user.market_id, req.user.id, 'reset_password', 'user', req.params.id, null);
  res.json({ success: true });
});

// ============================================================
// Market Settings
// ============================================================

router.get('/market', (req, res) => {
  const db = getDb();
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(req.user.market_id);
  res.json(market);
});

router.put('/market', (req, res) => {
  const db = getDb();
  const { name, default_delivery_fee_rate, default_service_charge_rate } = req.body;

  db.prepare(`
    UPDATE markets SET name = ?, default_delivery_fee_rate = ?, default_service_charge_rate = ?
    WHERE id = ?
  `).run(name, default_delivery_fee_rate, default_service_charge_rate, req.user.market_id);

  auditLog(req.user.market_id, req.user.id, 'update_market', 'market', req.user.market_id, req.body);
  res.json({ success: true });
});

export default router;
