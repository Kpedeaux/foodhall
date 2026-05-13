import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { sql } from '../db/database.js';

const router = Router();
router.use(authenticate);

// Vendor can only access their own approved data

// GET /api/vendor/weeks — list approved weeks for current year where this vendor has data
router.get('/weeks', async (req, res, next) => {
  try {
    if (req.user.role !== 'vendor' || !req.user.vendor_id) {
      return res.status(403).json({ error: 'Vendor access required' });
    }

    const currentYear = new Date().getFullYear();
    const yearStart = `${currentYear}-01-01`;

    const weeks = await sql`
      SELECT wp.id, wp.week_start, wp.week_end, wp.is_linen_week, wp.approved_at,
             ws.net_transfer, ws.tips_to_transfer
      FROM weekly_periods wp
      JOIN weekly_summaries ws ON ws.weekly_period_id = wp.id
      WHERE wp.market_id = ${req.user.market_id}
        AND wp.status = 'approved'
        AND ws.vendor_id = ${req.user.vendor_id}
        AND wp.week_start >= ${yearStart}
      ORDER BY wp.week_start DESC
    `;

    res.json(weeks);
  } catch (err) { next(err); }
});

// GET /api/vendor/weeks/:id/rankings — vendor rankings for a given week
router.get('/weeks/:id/rankings', async (req, res, next) => {
  try {
    if (req.user.role !== 'vendor' || !req.user.vendor_id) {
      return res.status(403).json({ error: 'Vendor access required' });
    }

    const [week] = await sql`
      SELECT * FROM weekly_periods
      WHERE id = ${req.params.id} AND market_id = ${req.user.market_id} AND status = 'approved'
    `;

    if (!week) return res.status(404).json({ error: 'Week not found' });

    // Get all non-excluded vendor summaries + transaction counts for this week
    const rankings = await sql`
      SELECT
        ws.vendor_id,
        v.name AS vendor_name,
        ws.total_sales,
        COALESCE(dc.total_transactions, 0) AS transaction_count
      FROM weekly_summaries ws
      JOIN vendors v ON ws.vendor_id = v.id
      LEFT JOIN (
        SELECT vendor_id, weekly_period_id, SUM(payment_count) AS total_transactions
        FROM daily_calculations
        GROUP BY vendor_id, weekly_period_id
      ) dc ON dc.vendor_id = ws.vendor_id AND dc.weekly_period_id = ws.weekly_period_id
      WHERE ws.weekly_period_id = ${week.id}
        AND v.is_excluded = FALSE
      ORDER BY ws.total_sales DESC
    `;

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
  } catch (err) { next(err); }
});

// GET /api/vendor/weeks/:id — get full detail for one approved week
router.get('/weeks/:id', async (req, res, next) => {
  try {
    if (req.user.role !== 'vendor' || !req.user.vendor_id) {
      return res.status(403).json({ error: 'Vendor access required' });
    }

    const [week] = await sql`
      SELECT * FROM weekly_periods
      WHERE id = ${req.params.id} AND market_id = ${req.user.market_id} AND status = 'approved'
    `;

    if (!week) return res.status(404).json({ error: 'Week not found' });

    const [summary] = await sql`
      SELECT ws.*, v.name AS vendor_name, v.plan_type, v.percentage_rate, v.daily_base_rent
      FROM weekly_summaries ws
      JOIN vendors v ON ws.vendor_id = v.id
      WHERE ws.weekly_period_id = ${week.id} AND ws.vendor_id = ${req.user.vendor_id}
    `;

    if (!summary) return res.status(404).json({ error: 'No data found for your stall this week' });

    const days = await sql`
      SELECT * FROM daily_calculations
      WHERE weekly_period_id = ${week.id} AND vendor_id = ${req.user.vendor_id}
      ORDER BY date
    `;

    const adjustments = await sql`
      SELECT a.id, a.type, a.amount, a.description, a.created_at
      FROM adjustments a
      WHERE a.weekly_summary_id = ${summary.id}
      ORDER BY a.created_at
    `;

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
  } catch (err) { next(err); }
});

export default router;
