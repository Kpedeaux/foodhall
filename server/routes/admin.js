import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { sql, auditLog } from '../db/database.js';
import bcrypt from 'bcryptjs';
import { listLocations } from '../services/square.js';
import { calculateTransfersForWeek } from '../services/calculator.js';
import { validatePassword } from '../middleware/passwordPolicy.js';

const router = Router();
router.use(authenticate, requireAdmin);

// ── Input coercion ──────────────────────────────
// Postgres BOOLEAN columns reject int4/text via the wire protocol, so any
// client that sends 0/1 or "true"/"false" must be coerced here. Returns a
// real boolean, or null if the input is missing/unrecognized — callers
// decide whether null means "leave unchanged" or "reject as 400".
function coerceBool(v) {
  if (v === true || v === false) return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 't' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'f' || s === 'no') return false;
  }
  return null;
}

// ============================================================
// Square Locations
// ============================================================

router.get('/square/locations', async (req, res, next) => {
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

router.get('/vendors', async (req, res, next) => {
  try {
    // Join the currently-effective terms (latest effective_from <= today).
    // COALESCE falls back to the vendor row's legacy columns if a vendor has
    // no vendor_terms row yet (shouldn't happen after migration, but defensive).
    const vendors = await sql`
      SELECT
        v.id, v.market_id, v.name, v.square_location_id,
        v.active, v.started_date, v.departed_date, v.is_excluded,
        v.created_at, v.updated_at,
        COALESCE(ct.plan_type,           v.plan_type)           AS plan_type,
        COALESCE(ct.percentage_rate,     v.percentage_rate)     AS percentage_rate,
        COALESCE(ct.daily_base_rent,     v.daily_base_rent)     AS daily_base_rent,
        COALESCE(ct.delivery_fee_rate,   v.delivery_fee_rate)   AS delivery_fee_rate,
        COALESCE(ct.service_charge_rate, v.service_charge_rate) AS service_charge_rate,
        COALESCE(ct.weekly_minimum,      v.weekly_minimum)      AS weekly_minimum,
        COALESCE(ct.linen_charge,        v.linen_charge)        AS linen_charge,
        ct.effective_from AS current_terms_effective_from
      FROM vendors v
      LEFT JOIN LATERAL (
        SELECT * FROM vendor_terms
        WHERE vendor_id = v.id AND effective_from <= CURRENT_DATE
        ORDER BY effective_from DESC LIMIT 1
      ) ct ON TRUE
      WHERE v.market_id = ${req.user.market_id}
      ORDER BY v.name
    `;

    let unconfigured = [];
    const [market] = await sql`
      SELECT square_environment FROM markets WHERE id = ${req.user.market_id}
    `;
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
  } catch (err) { next(err); }
});

router.post('/vendors', async (req, res, next) => {
  try {
    const {
      name, square_location_id, plan_type, percentage_rate, daily_base_rent,
      delivery_fee_rate, service_charge_rate, weekly_minimum, linen_charge,
      active, departed_date, is_excluded
    } = req.body;

    // Coerce boolean inputs. undefined → schema default (true / false).
    let activeBool = true;
    if (active !== undefined && active !== null) {
      activeBool = coerceBool(active);
      if (activeBool === null) return res.status(400).json({ error: 'active must be a boolean' });
    }
    let isExcludedBool = false;
    if (is_excluded !== undefined && is_excluded !== null) {
      isExcludedBool = coerceBool(is_excluded);
      if (isExcludedBool === null) return res.status(400).json({ error: 'is_excluded must be a boolean' });
    }

    // Initial vendor_terms effective_from defaults to started_date (or today
    // if no started_date provided). This guarantees the vendor has at least
    // one effective plan row from day one.
    const startedDate = req.body.started_date || null;
    const effectiveFrom = startedDate || new Date().toISOString().slice(0, 10);

    const newId = await sql.begin(async (sql) => {
      const [v] = await sql`
        INSERT INTO vendors (
          market_id, name, square_location_id, plan_type, percentage_rate, daily_base_rent,
          delivery_fee_rate, service_charge_rate, weekly_minimum, linen_charge,
          active, started_date, departed_date, is_excluded
        ) VALUES (
          ${req.user.market_id}, ${name}, ${square_location_id || null},
          ${plan_type || 'STANDARD'}, ${percentage_rate ?? 0.30}, ${daily_base_rent ?? 0},
          ${delivery_fee_rate ?? 0.105}, ${service_charge_rate ?? 0.02},
          ${weekly_minimum ?? 0}, ${linen_charge ?? 0},
          ${activeBool}, ${startedDate}, ${departed_date || null}, ${isExcludedBool}
        )
        RETURNING id
      `;

      await sql`
        INSERT INTO vendor_terms (
          vendor_id, effective_from, plan_type, percentage_rate, daily_base_rent,
          delivery_fee_rate, service_charge_rate, weekly_minimum, linen_charge, created_by
        ) VALUES (
          ${v.id}, ${effectiveFrom},
          ${plan_type || 'STANDARD'}, ${percentage_rate ?? 0.30}, ${daily_base_rent ?? 0},
          ${delivery_fee_rate ?? 0.105}, ${service_charge_rate ?? 0.02},
          ${weekly_minimum ?? 0}, ${linen_charge ?? 0}, ${req.user.id}
        )
      `;

      return v.id;
    });

    await auditLog(req.user.market_id, req.user.id, 'create_vendor', 'vendor', newId, req.body);
    res.json({ id: newId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/vendors/:id', async (req, res, next) => {
  try {
    const [vendor] = await sql`
      SELECT * FROM vendors WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    // Plan/economic fields are NOT editable here anymore — they live in
    // vendor_terms with effective dates. Changes go through
    // POST /vendors/:id/plan-changes. The body's plan fields are silently
    // ignored to keep legacy clients from accidentally rewriting the legacy
    // columns out of sync with vendor_terms.
    const { name, square_location_id, active, started_date, departed_date, is_excluded } = req.body;

    let nextActive = vendor.active;
    if (active !== undefined && active !== null) {
      const b = coerceBool(active);
      if (b === null) return res.status(400).json({ error: 'active must be a boolean' });
      nextActive = b;
    }
    let nextIsExcluded = vendor.is_excluded;
    if (is_excluded !== undefined && is_excluded !== null) {
      const b = coerceBool(is_excluded);
      if (b === null) return res.status(400).json({ error: 'is_excluded must be a boolean' });
      nextIsExcluded = b;
    }

    await sql`
      UPDATE vendors SET
        name = ${name ?? vendor.name},
        square_location_id = ${square_location_id ?? vendor.square_location_id},
        active = ${nextActive},
        started_date = ${started_date !== undefined ? (started_date || null) : vendor.started_date},
        departed_date = ${departed_date !== undefined ? (departed_date || null) : vendor.departed_date},
        is_excluded = ${nextIsExcluded},
        updated_at = now()
      WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;

    await auditLog(req.user.market_id, req.user.id, 'update_vendor', 'vendor', req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// Vendor Plan History (date-versioned terms)
// ============================================================
// Each vendor has one or more vendor_terms rows. The plan effective for a
// given week is the row with the latest effective_from <= week_start. Adding
// a new entry never changes already-approved weeks, but draft weeks pick up
// the change on next recalc.

router.get('/vendors/:id/plan-history', async (req, res, next) => {
  try {
    const [vendor] = await sql`
      SELECT id FROM vendors WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const history = await sql`
      SELECT vt.*, u.username AS created_by_username
        FROM vendor_terms vt
        LEFT JOIN users u ON vt.created_by = u.id
        WHERE vt.vendor_id = ${req.params.id}
        ORDER BY vt.effective_from DESC
    `;
    res.json(history);
  } catch (err) { next(err); }
});

router.post('/vendors/:id/plan-changes', async (req, res, next) => {
  try {
    const [vendor] = await sql`
      SELECT id FROM vendors WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const {
      effective_from, plan_type, percentage_rate, daily_base_rent,
      delivery_fee_rate, service_charge_rate, weekly_minimum, linen_charge,
    } = req.body;

    if (!effective_from) return res.status(400).json({ error: 'effective_from required (YYYY-MM-DD)' });
    if (!plan_type)      return res.status(400).json({ error: 'plan_type required' });
    if (!['FLAT', 'STANDARD', 'WEEKLY'].includes(plan_type)) {
      return res.status(400).json({ error: 'plan_type must be FLAT, STANDARD, or WEEKLY' });
    }

    try {
      const [row] = await sql`
        INSERT INTO vendor_terms (
          vendor_id, effective_from, plan_type, percentage_rate, daily_base_rent,
          delivery_fee_rate, service_charge_rate, weekly_minimum, linen_charge, created_by
        ) VALUES (
          ${req.params.id}, ${effective_from},
          ${plan_type}, ${percentage_rate ?? 0.30}, ${daily_base_rent ?? 0},
          ${delivery_fee_rate ?? 0.105}, ${service_charge_rate ?? 0.02},
          ${weekly_minimum ?? 0}, ${linen_charge ?? 0}, ${req.user.id}
        )
        RETURNING id
      `;
      await auditLog(req.user.market_id, req.user.id, 'add_plan_change', 'vendor_terms', row.id, {
        vendor_id: Number(req.params.id), effective_from, plan_type, percentage_rate, daily_base_rent,
      });
      res.json({ id: row.id });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(400).json({
          error: 'A plan entry already exists for this effective date on this vendor. Delete it first or pick a different date.',
        });
      }
      throw err;
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/vendors/:id/plan-changes/:planId', async (req, res, next) => {
  try {
    const [row] = await sql`
      SELECT vt.id, vt.effective_from
        FROM vendor_terms vt
        JOIN vendors v ON vt.vendor_id = v.id
        WHERE vt.id = ${req.params.planId}
          AND vt.vendor_id = ${req.params.id}
          AND v.market_id = ${req.user.market_id}
    `;
    if (!row) return res.status(404).json({ error: 'Plan entry not found' });

    // Refuse to delete the only remaining entry; would leave the vendor with
    // no effective terms and the calculator would silently exclude them.
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM vendor_terms WHERE vendor_id = ${req.params.id}`;
    if (count <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only plan entry. Add a new one first.' });
    }

    await sql`DELETE FROM vendor_terms WHERE id = ${req.params.planId}`;
    await auditLog(req.user.market_id, req.user.id, 'delete_plan_change', 'vendor_terms', req.params.planId, {
      vendor_id: Number(req.params.id), effective_from: row.effective_from,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// Weekly Periods
// ============================================================

router.get('/weeks', async (req, res, next) => {
  try {
    const weeks = await sql`
      SELECT wp.*, u.username AS approved_by_username
      FROM weekly_periods wp
      LEFT JOIN users u ON wp.approved_by = u.id
      WHERE wp.market_id = ${req.user.market_id}
      ORDER BY wp.week_start DESC
    `;
    res.json(weeks);
  } catch (err) { next(err); }
});

router.get('/weeks/:id', async (req, res, next) => {
  try {
    const [week] = await sql`
      SELECT * FROM weekly_periods WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;
    if (!week) return res.status(404).json({ error: 'Week not found' });

    const summaries = await sql`
      SELECT ws.*, v.name AS vendor_name, v.plan_type, v.percentage_rate, v.daily_base_rent
      FROM weekly_summaries ws
      JOIN vendors v ON ws.vendor_id = v.id
      WHERE ws.weekly_period_id = ${week.id}
      ORDER BY v.name
    `;

    const dailyCalcs = await sql`
      SELECT dc.*, v.name AS vendor_name
      FROM daily_calculations dc
      JOIN vendors v ON dc.vendor_id = v.id
      WHERE dc.weekly_period_id = ${week.id}
      ORDER BY v.name, dc.date
    `;

    const adjustments = await sql`
      SELECT a.*, ws.vendor_id
      FROM adjustments a
      JOIN weekly_summaries ws ON a.weekly_summary_id = ws.id
      WHERE ws.weekly_period_id = ${week.id}
      ORDER BY a.created_at
    `;

    const dailyByVendor = {};
    for (const dc of dailyCalcs) {
      if (!dailyByVendor[dc.vendor_id]) dailyByVendor[dc.vendor_id] = [];
      dailyByVendor[dc.vendor_id].push(dc);
    }

    const adjByVendor = {};
    for (const adj of adjustments) {
      if (!adjByVendor[adj.vendor_id]) adjByVendor[adj.vendor_id] = [];
      adjByVendor[adj.vendor_id].push(adj);
    }

    const grandTotals = {
      totalSales: 0, totalMarketFees: 0, totalDeliveryFees: 0,
      totalSquareFees: 0, totalCash: 0, totalTransfers: 0,
      totalTips: 0, totalLinenCharges: 0, totalServiceCharges: 0,
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
      grandTotals.totalServiceCharges += s.service_charge;

      return {
        ...s,
        days: dailyByVendor[s.vendor_id] || [],
        adjustments: adjByVendor[s.vendor_id] || [],
      };
    });

    for (const key of Object.keys(grandTotals)) {
      grandTotals[key] = Math.round(grandTotals[key] * 100) / 100;
    }

    res.json({ week, vendors: vendorSummaries, grandTotals });
  } catch (err) { next(err); }
});

async function assertSquareReachable() {
  try {
    await listLocations();
  } catch (err) {
    const msg = err?.message || String(err);
    // Upstream auth/config failures get 503 (Service Unavailable) rather than
    // 502, because edge proxies (Cloudflare, DO App Platform) routinely replace
    // 502 origin responses with their own HTML error pages — which destroys
    // the JSON body the SPA relies on. 503 passes through.
    const isAuth = /UNAUTHORIZED|AUTHENTICATION_ERROR|not authorized/i.test(msg);
    const userMessage = isAuth
      ? 'Square access token is rejected by Square. Verify SQUARE_ACCESS_TOKEN and SQUARE_ENVIRONMENT in App Platform → Settings → Components → foodhall → Environment Variables.'
      : `Square is not reachable: ${msg}`;
    throw Object.assign(new Error(userMessage), { status: 503 });
  }
}

router.post('/weeks/pull', async (req, res, next) => {
  const { weekStart, isLinenWeek, closureDays, earlyCloseDays } = req.body;
  if (!weekStart) return res.status(400).json({ error: 'weekStart required' });

  try {
    await assertSquareReachable();
    const result = await calculateTransfersForWeek(
      req.user.market_id, weekStart, !!isLinenWeek, req.user.id,
      closureDays || [], earlyCloseDays || []
    );
    res.json(result);
  } catch (err) {
    console.error('Transfer calculation error:', err);
    next(err);
  }
});

router.post('/weeks/:id/recalculate', async (req, res, next) => {
  try {
    const [week] = await sql`
      SELECT * FROM weekly_periods WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;
    if (!week) return res.status(404).json({ error: 'Week not found' });
    if (week.status !== 'draft') return res.status(400).json({ error: 'Can only recalculate draft weeks' });

    await assertSquareReachable();
    const savedClosureDays = Array.isArray(week.closure_days) ? week.closure_days : [];
    const savedEarlyCloseDays = Array.isArray(week.early_close_days) ? week.early_close_days : [];
    const closureDays = req.body.closureDays || savedClosureDays;
    const earlyCloseDays = req.body.earlyCloseDays || savedEarlyCloseDays;
    const result = await calculateTransfersForWeek(
      req.user.market_id, week.week_start, !!week.is_linen_week, req.user.id,
      closureDays, earlyCloseDays
    );
    res.json(result);
  } catch (err) {
    console.error('Recalculate error:', err);
    next(err);
  }
});

router.post('/weeks/:id/approve', async (req, res, next) => {
  try {
    const [week] = await sql`
      SELECT * FROM weekly_periods WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;
    if (!week) return res.status(404).json({ error: 'Week not found' });
    if (week.status !== 'draft') return res.status(400).json({ error: 'Week is already approved' });

    await sql`
      UPDATE weekly_periods
      SET status = 'approved', approved_by = ${req.user.id}, approved_at = now()
      WHERE id = ${week.id}
    `;

    await auditLog(req.user.market_id, req.user.id, 'approve_week', 'weekly_period', week.id, { week_start: week.week_start });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/weeks/:id/unlock', async (req, res, next) => {
  try {
    const [week] = await sql`
      SELECT * FROM weekly_periods WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;
    if (!week) return res.status(404).json({ error: 'Week not found' });
    if (week.status !== 'approved') return res.status(400).json({ error: 'Week is not approved' });

    await sql`
      UPDATE weekly_periods
      SET status = 'draft', approved_by = NULL, approved_at = NULL
      WHERE id = ${week.id}
    `;

    await auditLog(req.user.market_id, req.user.id, 'unlock_week', 'weekly_period', week.id, { week_start: week.week_start });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// Adjustments
// ============================================================

router.post('/adjustments', async (req, res, next) => {
  try {
    const { weekly_summary_id, type, amount, description } = req.body;

    const [summary] = await sql`
      SELECT ws.*, wp.market_id, wp.status
      FROM weekly_summaries ws
      JOIN weekly_periods wp ON ws.weekly_period_id = wp.id
      WHERE ws.id = ${weekly_summary_id}
    `;

    if (!summary || summary.market_id !== req.user.market_id) {
      return res.status(404).json({ error: 'Summary not found' });
    }
    if (summary.status !== 'draft') {
      return res.status(400).json({ error: 'Cannot modify adjustments on approved weeks' });
    }

    const [result] = await sql`
      INSERT INTO adjustments (weekly_summary_id, type, amount, description, created_by)
      VALUES (${weekly_summary_id}, ${type}, ${amount}, ${description}, ${req.user.id})
      RETURNING id
    `;

    await recalcNetTransfer(weekly_summary_id);

    await auditLog(req.user.market_id, req.user.id, 'add_adjustment', 'adjustment', result.id, { type, amount, description });
    res.json({ id: result.id });
  } catch (err) { next(err); }
});

router.delete('/adjustments/:id', async (req, res, next) => {
  try {
    const [adj] = await sql`
      SELECT a.*, ws.id AS summary_id, wp.market_id, wp.status
      FROM adjustments a
      JOIN weekly_summaries ws ON a.weekly_summary_id = ws.id
      JOIN weekly_periods wp ON ws.weekly_period_id = wp.id
      WHERE a.id = ${req.params.id}
    `;

    if (!adj || adj.market_id !== req.user.market_id) {
      return res.status(404).json({ error: 'Adjustment not found' });
    }
    if (adj.status !== 'draft') {
      return res.status(400).json({ error: 'Cannot modify adjustments on approved weeks' });
    }

    await sql`DELETE FROM adjustments WHERE id = ${req.params.id}`;
    await recalcNetTransfer(adj.summary_id);

    await auditLog(req.user.market_id, req.user.id, 'delete_adjustment', 'adjustment', req.params.id, null);
    res.json({ success: true });
  } catch (err) { next(err); }
});

async function recalcNetTransfer(weeklySummaryId) {
  const [adjs] = await sql`
    SELECT COALESCE(SUM(amount), 0) AS total FROM adjustments WHERE weekly_summary_id = ${weeklySummaryId}
  `;
  const totalAdj = adjs.total || 0;

  const [summary] = await sql`
    SELECT gross_transfer, prior_balance_due FROM weekly_summaries WHERE id = ${weeklySummaryId}
  `;
  const priorBalance = summary.prior_balance_due || 0;
  const netTransfer = Math.round((summary.gross_transfer + totalAdj - priorBalance) * 100) / 100;
  const balanceDue = netTransfer < 0 ? Math.round(Math.abs(netTransfer) * 100) / 100 : 0;

  await sql`
    UPDATE weekly_summaries
    SET net_transfer = ${netTransfer}, balance_due = ${balanceDue}
    WHERE id = ${weeklySummaryId}
  `;
}

// ============================================================
// User Management
// ============================================================

router.get('/users', async (req, res, next) => {
  try {
    const users = await sql`
      SELECT u.id, u.username, u.role, u.email, u.active, u.vendor_id,
             u.must_change_password, u.created_at, v.name AS vendor_name
      FROM users u
      LEFT JOIN vendors v ON u.vendor_id = v.id
      WHERE u.market_id = ${req.user.market_id}
      ORDER BY u.role, u.username
    `;
    res.json(users);
  } catch (err) { next(err); }
});

router.post('/users', async (req, res, next) => {
  try {
    const { username, password, role, vendor_id, email } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const policy = validatePassword(password);
    if (!policy.valid) {
      return res.status(400).json({ error: policy.errors.join('. ') });
    }
    if (role === 'vendor' && !vendor_id) {
      return res.status(400).json({ error: 'Vendor accounts must be linked to a vendor' });
    }

    // ── H2 (2026-05-15 audit) ───────────────────────────────────
    // If vendor_id is supplied, verify it belongs to the caller's market.
    if (vendor_id !== undefined && vendor_id !== null) {
      const [v] = await sql`
        SELECT id FROM vendors WHERE id = ${vendor_id} AND market_id = ${req.user.market_id}
      `;
      if (!v) {
        return res.status(400).json({ error: 'vendor_id does not belong to your market' });
      }
    }

    const hash = bcrypt.hashSync(password, 12);
    let result;
    try {
      [result] = await sql`
        INSERT INTO users (market_id, username, password_hash, role, vendor_id, email, must_change_password)
        VALUES (${req.user.market_id}, ${username}, ${hash}, ${role || 'vendor'},
                ${vendor_id || null}, ${email || null}, TRUE)
        RETURNING id
      `;
    } catch (err) {
      if (err.code === '23505') {
        return res.status(400).json({ error: 'Username already exists' });
      }
      throw err;
    }

    await auditLog(req.user.market_id, req.user.id, 'create_user', 'user', result.id, { username, role });
    res.json({ id: result.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/users/:id', async (req, res, next) => {
  try {
    const [user] = await sql`
      SELECT * FROM users WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Strict body allowlist — never trust the client to scope which columns
    // can be set. Anything outside this list is silently dropped.
    const { username, email, active, vendor_id } = req.body;

    // ── H2 (2026-05-15 audit) ───────────────────────────────────
    // If vendor_id is being set, verify it belongs to the caller's market.
    // Without this check, an admin in market A can reassign one of their
    // vendor accounts to a vendor row in market B and read its data.
    if (vendor_id !== undefined && vendor_id !== null) {
      const [v] = await sql`
        SELECT id FROM vendors WHERE id = ${vendor_id} AND market_id = ${req.user.market_id}
      `;
      if (!v) {
        return res.status(400).json({ error: 'vendor_id does not belong to your market' });
      }
    }

    // Coerce `active` to a real boolean. Postgres BOOLEAN columns reject
    // integers/strings over the wire, so a client that sends `active: 0`
    // would otherwise blow up with a cryptic type error. undefined/null
    // means "leave unchanged"; anything else must be a recognized boolean.
    let nextActive = user.active;
    if (active !== undefined && active !== null) {
      const b = coerceBool(active);
      if (b === null) {
        return res.status(400).json({ error: 'active must be a boolean' });
      }
      nextActive = b;
    }

    await sql`
      UPDATE users SET
        username = ${username ?? user.username},
        email = ${email ?? user.email},
        active = ${nextActive},
        vendor_id = ${vendor_id ?? user.vendor_id}
      WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;

    // Log only the fields actually accepted; never the raw req.body
    // (which may contain a stray `password` field or other surprises).
    await auditLog(req.user.market_id, req.user.id, 'update_user', 'user', req.params.id, {
      username, email, active: nextActive, vendor_id,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const [user] = await sql`
      SELECT * FROM users WHERE id = ${req.params.id} AND market_id = ${req.user.market_id}
    `;
    if (!user) return res.status(404).json({ error: 'User not found' });

    // ── C1 (2026-05-15 audit) ───────────────────────────────────
    // Admins cannot reset OTHER admins' passwords. One compromised admin
    // account must not unlock the rest of the admin tier. An admin who
    // needs to change their own password uses /api/auth/change-password
    // (requires current password). An admin who lost their password uses
    // the lost-password flow (out-of-band).
    if (user.role === 'admin' && user.id !== req.user.id) {
      return res.status(403).json({
        error: "Admins cannot reset other admins' passwords. The target admin must change their own password via the lost-password flow."
      });
    }

    const { newPassword } = req.body;
    const policy = validatePassword(newPassword);
    if (!policy.valid) {
      return res.status(400).json({ error: policy.errors.join('. ') });
    }

    const hash = bcrypt.hashSync(newPassword, 12);
    await sql`
      UPDATE users SET password_hash = ${hash}, must_change_password = TRUE
      WHERE id = ${user.id}
    `;

    await auditLog(req.user.market_id, req.user.id, 'reset_password', 'user', req.params.id, null);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// Market Settings
// ============================================================

router.get('/market', async (req, res, next) => {
  try {
    const [market] = await sql`SELECT * FROM markets WHERE id = ${req.user.market_id}`;
    res.json(market);
  } catch (err) { next(err); }
});

router.put('/market', async (req, res, next) => {
  try {
    const { name, default_delivery_fee_rate, default_service_charge_rate } = req.body;

    await sql`
      UPDATE markets SET
        name = ${name},
        default_delivery_fee_rate = ${default_delivery_fee_rate},
        default_service_charge_rate = ${default_service_charge_rate}
      WHERE id = ${req.user.market_id}
    `;

    await auditLog(req.user.market_id, req.user.id, 'update_market', 'market', req.user.market_id, req.body);
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
