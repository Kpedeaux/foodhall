// Excel Export Service — generates .xlsx files for CPA reporting
import ExcelJS from 'exceljs';
import { sql } from '../db/database.js';

const CURRENCY_FORMAT = '$#,##0.00';

function applyHeaderStyle(row) {
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
    };
  });
  row.height = 22;
}

function applyCurrencyFormat(sheet, startCol, endCol) {
  for (let col = startCol; col <= endCol; col++) {
    sheet.getColumn(col).numFmt = CURRENCY_FORMAT;
    sheet.getColumn(col).width = 15;
  }
}

/**
 * Export a single vendor's annual data as an Excel workbook.
 */
export async function exportVendorAnnual(vendorId, year) {
  const [vendor] = await sql`SELECT * FROM vendors WHERE id = ${vendorId}`;
  if (!vendor) throw new Error('Vendor not found');

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;

  const summaries = await sql`
    SELECT ws.*, wp.week_start, wp.week_end, wp.is_linen_week
    FROM weekly_summaries ws
    JOIN weekly_periods wp ON ws.weekly_period_id = wp.id
    WHERE ws.vendor_id = ${vendorId}
      AND wp.status = 'approved'
      AND wp.week_start >= ${yearStart}
      AND wp.week_start < ${yearEnd}
    ORDER BY wp.week_start
  `;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Food Hall Manager';
  workbook.created = new Date();

  // Sheet 1: Sales Transfers
  const salesSheet = workbook.addWorksheet('Sales Transfers');
  salesSheet.columns = [
    { header: 'Week Start', key: 'week_start', width: 14 },
    { header: 'Week End', key: 'week_end', width: 14 },
    { header: 'Total Sales', key: 'total_sales', width: 15 },
    { header: 'Market Fee', key: 'total_market_fee', width: 15 },
    { header: 'Square Fees', key: 'total_square_fees', width: 15 },
    { header: 'Cash Collected', key: 'total_cash', width: 15 },
    { header: 'Delivery Fee', key: 'delivery_fee', width: 15 },
    { header: 'Linen Charge', key: 'linen_charge', width: 15 },
    { header: 'Wkly Min Bump', key: 'weekly_minimum_bump', width: 15 },
    { header: 'Adjustments', key: 'adjustments_total', width: 15 },
    { header: 'Gross Transfer', key: 'gross_transfer', width: 15 },
    { header: 'Net Transfer', key: 'net_transfer', width: 15 },
  ];

  applyHeaderStyle(salesSheet.getRow(1));

  for (const s of summaries) {
    const [adjTotal] = await sql`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM adjustments
      WHERE weekly_summary_id = ${s.id}
    `;

    salesSheet.addRow({
      week_start: s.week_start,
      week_end: s.week_end,
      total_sales: s.total_sales,
      total_market_fee: s.total_market_fee,
      total_square_fees: s.total_square_fees,
      total_cash: s.total_cash,
      delivery_fee: s.delivery_fee,
      linen_charge: s.linen_charge,
      weekly_minimum_bump: s.weekly_minimum_bump,
      adjustments_total: adjTotal.total,
      gross_transfer: s.gross_transfer,
      net_transfer: s.net_transfer,
    });
  }

  applyCurrencyFormat(salesSheet, 3, 12);

  // Totals row
  if (summaries.length > 0) {
    const lastRow = summaries.length + 1;
    const totalsRow = salesSheet.addRow({
      week_start: 'TOTALS',
      total_sales: { formula: `SUM(C2:C${lastRow})` },
      total_market_fee: { formula: `SUM(D2:D${lastRow})` },
      total_square_fees: { formula: `SUM(E2:E${lastRow})` },
      total_cash: { formula: `SUM(F2:F${lastRow})` },
      delivery_fee: { formula: `SUM(G2:G${lastRow})` },
      linen_charge: { formula: `SUM(H2:H${lastRow})` },
      weekly_minimum_bump: { formula: `SUM(I2:I${lastRow})` },
      adjustments_total: { formula: `SUM(J2:J${lastRow})` },
      gross_transfer: { formula: `SUM(K2:K${lastRow})` },
      net_transfer: { formula: `SUM(L2:L${lastRow})` },
    });
    totalsRow.font = { bold: true };
    totalsRow.border = { top: { style: 'double', color: { argb: 'FF000000' } } };
  }

  // Sheet 2: Tips
  const tipsSheet = workbook.addWorksheet('Tips');
  tipsSheet.columns = [
    { header: 'Week Start', key: 'week_start', width: 14 },
    { header: 'Week End', key: 'week_end', width: 14 },
    { header: 'Total Tips', key: 'total_tips', width: 15 },
    { header: 'Service Charge', key: 'service_charge', width: 15 },
    { header: 'Tips Transferred', key: 'tips_to_transfer', width: 18 },
  ];

  applyHeaderStyle(tipsSheet.getRow(1));

  for (const s of summaries) {
    tipsSheet.addRow({
      week_start: s.week_start,
      week_end: s.week_end,
      total_tips: s.total_tips,
      service_charge: s.service_charge,
      tips_to_transfer: s.tips_to_transfer,
    });
  }

  applyCurrencyFormat(tipsSheet, 3, 5);

  if (summaries.length > 0) {
    const lastRow = summaries.length + 1;
    const totalsRow = tipsSheet.addRow({
      week_start: 'TOTALS',
      total_tips: { formula: `SUM(C2:C${lastRow})` },
      service_charge: { formula: `SUM(D2:D${lastRow})` },
      tips_to_transfer: { formula: `SUM(E2:E${lastRow})` },
    });
    totalsRow.font = { bold: true };
    totalsRow.border = { top: { style: 'double', color: { argb: 'FF000000' } } };
  }

  return { workbook, vendorName: vendor.name };
}

/**
 * Export all vendors' annual data. One sheet per vendor for both sales and tips.
 */
export async function exportAllVendors(marketId, year) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;

  const vendors = await sql`
    SELECT DISTINCT v.id, v.name
    FROM vendors v
    JOIN weekly_summaries ws ON ws.vendor_id = v.id
    JOIN weekly_periods wp ON ws.weekly_period_id = wp.id
    WHERE v.market_id = ${marketId}
      AND wp.status = 'approved'
      AND wp.week_start >= ${yearStart}
      AND wp.week_start < ${yearEnd}
    ORDER BY v.name
  `;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Food Hall Manager';
  workbook.created = new Date();

  for (const vendor of vendors) {
    const summaries = await sql`
      SELECT ws.*, wp.week_start, wp.week_end
      FROM weekly_summaries ws
      JOIN weekly_periods wp ON ws.weekly_period_id = wp.id
      WHERE ws.vendor_id = ${vendor.id}
        AND wp.status = 'approved'
        AND wp.week_start >= ${yearStart}
        AND wp.week_start < ${yearEnd}
      ORDER BY wp.week_start
    `;

    const sheetName = vendor.name.substring(0, 28);

    // Sales sheet
    const salesSheet = workbook.addWorksheet(`${sheetName} Sales`);
    salesSheet.columns = [
      { header: 'Week Start', key: 'week_start', width: 14 },
      { header: 'Total Sales', key: 'total_sales', width: 15 },
      { header: 'Market Fee', key: 'total_market_fee', width: 15 },
      { header: 'Square Fees', key: 'total_square_fees', width: 15 },
      { header: 'Cash', key: 'total_cash', width: 15 },
      { header: 'Delivery Fee', key: 'delivery_fee', width: 15 },
      { header: 'Net Transfer', key: 'net_transfer', width: 15 },
    ];
    applyHeaderStyle(salesSheet.getRow(1));

    for (const s of summaries) {
      salesSheet.addRow({
        week_start: s.week_start,
        total_sales: s.total_sales,
        total_market_fee: s.total_market_fee,
        total_square_fees: s.total_square_fees,
        total_cash: s.total_cash,
        delivery_fee: s.delivery_fee,
        net_transfer: s.net_transfer,
      });
    }
    applyCurrencyFormat(salesSheet, 2, 7);

    // Tips sheet
    const tipsSheet = workbook.addWorksheet(`${sheetName} Tips`);
    tipsSheet.columns = [
      { header: 'Week Start', key: 'week_start', width: 14 },
      { header: 'Total Tips', key: 'total_tips', width: 15 },
      { header: 'Service Charge', key: 'service_charge', width: 15 },
      { header: 'Tips Transferred', key: 'tips_to_transfer', width: 18 },
    ];
    applyHeaderStyle(tipsSheet.getRow(1));

    for (const s of summaries) {
      tipsSheet.addRow({
        week_start: s.week_start,
        total_tips: s.total_tips,
        service_charge: s.service_charge,
        tips_to_transfer: s.tips_to_transfer,
      });
    }
    applyCurrencyFormat(tipsSheet, 2, 4);
  }

  return { workbook, vendorCount: vendors.length };
}
