import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { getDb } from '../db/database.js';

const router = Router();
router.use(authenticate);

// Vendor can only access their own approved data

// GET /api/vendor/weeks — list approved weeks for current year where this vendor has data
router.get('/weeks', (req, res) => {
  if (req.user.role !== 'vendor' || !req.user.vendor_id) {
    return res.status(403).json({ error: 'Vendor access required' });
  }

  const db = getDb();
  const currentYear = new Date().getFullYear();

  const weeks = db.prepare(`
    SELECT wp.id, wp.week_start, wp.week_end, wp.is_linen_week, wp.approved_at,
           ws.net_transfer, ws.tips_to_transfer
    FROM weekly_periods wp
    JOIN weekly_summaries ws ON ws.weekly_period_id = wp.id
    WHERE wp.market_id = ?
      AND wp.status = 'approved'
      AND ws.vendor_id = ?
      AND wp.week_start >= ?
    ORDER BY wp.week_start DESC
  `).all(req.user.market_id, req.user.vendor_id, `${currentYear}-01-01`);

  res.json(weeks);
});

// GET /api/vendor/weeks/:id/rankings — vendor rankings for a given week
router.get('/weeks/:id/rankings', (req, res) => {
  if (req.user.role !== 'vendor' || !req.user.vendor_id) {
    return res.status(403).json({ error: 'Vendor access required' });
  }

  const db = getDb();
  const week = db.prepare(`
    SELECT * FROM weekly_periods WHERE id = ? AND market_id = ? AND status = 'approved'
  `).get(req.params.id, req.user.market_id);

  if (!week) return res.status(404).json({ error: 'Week not found' });

  // Get all non-excluded vendor summaries + transaction counts for this week
  const rankings = db.prepare(`
    SELECT
      ws.vendor_id,
      v.name as vendor_name,
      ws.total_sales,
      COALESCE(dc.total_transactions, 0) as transaction_count
    FROM weekly_summaries ws
    JOIN vendors v ON ws.vendor_id = v.id
    LEFT JOIN (
      SELECT vendor_id, weekly_period_id, SUM(payment_count) as total_transactions
      FROM daily_calculations
      GROUP BY vendor_id, weekly_period_id
    ) dc ON dc.vendor_id = ws.vendor_id AND dc.weekly_period_id = ws.weekly_period_id
    WHERE ws.weekly_period_id = ?
      AND v.is_excluded = 0
    ORDER BY ws.total_sales DESC
  `).all(week.id);

  // Assign ranks (handle ties — same sales = same rank)
  const bySales = [...rankings].sort((a, b) => b.total_sales - a.total_sales);
  const byTransactions = [...rankings].sort((a, b) => b.transaction_count - a.transaction_count);

  const assignRanks = (sorted, field) => {
    let rank = 1;
    return sorted.map((item, i) => {
      if (i > 0 && item[field] < sorted[i - 1][field]) {
        rank = i + 1;
      }
      return { ...item, rank };
    });
  };

  const salesRanked = assignRanks(bySales, 'total_sales');
  const txRanked = assignRanks(byTransactions, 'transaction_count');

  // Only return the current vendor's rank — no other vendor data exposed
  const mySalesRank = salesRanked.find(r => r.vendor_id === req.user.vendor_id);
  const myTxRank = txRanked.find(r => r.vendor_id === req.user.vendor_id);

  res.json({
    totalVendors: rankings.length,
    salesRank: mySalesRank ? mySalesRank.rank : null,
    transactionRank: myTxRank ? myTxRank.rank : null,
  });
});

// GET /api/vendor/weeks/:id — get full detail for one approved week
router.get('/weeks/:id', (req, res) => {
  if (req.user.role !== 'vendor' || !req.user.vendor_id) {
    return res.status(403).json({ error: 'Vendor access required' });
  }

  const db = getDb();
  const week = db.prepare(`
    SELECT * FROM weekly_periods WHERE id = ? AND market_id = ? AND status = 'approved'
  `).get(req.params.id, req.user.market_id);

  if (!week) return res.status(404).json({ error: 'Week not found' });

  const summary = db.prepare(`
    SELECT ws.*, v.name as vendor_name, v.plan_type, v.percentage_rate, v.daily_base_rent
    FROM weekly_summaries ws
    JOIN vendors v ON ws.vendor_id = v.id
    WHERE ws.weekly_period_id = ? AND ws.vendor_id = ?
  `).get(week.id, req.user.vendor_id);

  if (!summary) return res.status(404).json({ error: 'No data found for your stall this week' });

  const days = db.prepare(`
    SELECT * FROM daily_calculations
    WHERE weekly_period_id = ? AND vendor_id = ?
    ORDER BY date
  `).all(week.id, req.user.vendor_id);

  const adjustments = db.prepare(`
    SELECT a.id, a.type, a.amount, a.description, a.created_at
    FROM adjustments a
    WHERE a.weekly_summary_id = ?
    ORDER BY a.created_at
  `).all(summary.id);

  res.json({
    week: {
      week_start: week.week_start,
      week_end: week.week_end,
      is_linen_week: week.is_linen_week,
      approved_at: week.approved_at,
    },
    summary,
    days,
    adjustments,
  });
});

export default router;
