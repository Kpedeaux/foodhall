import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { exportVendorAnnual, exportAllVendors } from '../services/exporter.js';
import { getDb } from '../db/database.js';

const router = Router();
router.use(authenticate, requireAdmin);

// Export single vendor annual report
router.get('/:vendorId/:year', async (req, res) => {
  try {
    const vendorId = parseInt(req.params.vendorId);
    const year = parseInt(req.params.year);

    // SECURITY: Verify vendor belongs to the admin's market
    const db = getDb();
    const vendor = db.prepare('SELECT id FROM vendors WHERE id = ? AND market_id = ?')
      .get(vendorId, req.user.market_id);
    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found in your market' });
    }

    const { workbook, vendorName } = await exportVendorAnnual(vendorId, year);

    const filename = `${vendorName.replace(/[^a-zA-Z0-9]/g, '_')}_${year}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export all vendors annual report
router.get('/all/:year', async (req, res) => {
  try {
    const year = parseInt(req.params.year);
    const { workbook, vendorCount } = await exportAllVendors(req.user.market_id, year);

    if (vendorCount === 0) {
      return res.status(404).json({ error: 'No approved data found for this year' });
    }

    const db = getDb();
    const market = db.prepare('SELECT name FROM markets WHERE id = ?').get(req.user.market_id);
    const marketName = (market?.name || 'Market').replace(/[^a-zA-Z0-9]/g, '_');

    const filename = `${marketName}_All_Vendors_${year}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
