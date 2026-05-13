// Transfer Calculation Engine
// Adapted from stroch-transfers — preserves exact calculation logic.
//
// Safety design:
//   1. Phase 1 — fetch from Square and compute everything in memory.
//      No DB writes occur here, so a Square/network failure can never
//      leave the week's existing data deleted.
//   2. Phase 2 — inside a single Postgres transaction (sql.begin()),
//      delete old rows for this week and insert the freshly computed rows.
//      If any write throws, the transaction rolls back and the prior data
//      is preserved.

import { sql, auditLog } from '../db/database.js';
import {
  fetchAllPayments, fetchAllOrders, getWeekDates, getDayName,
  getLocalDate, toDollarsRaw, isDeliveryOrder, getCentralOffset
} from './square.js';

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Main orchestrator: pull Square data for a week, calculate transfers, store in DB.
 * Returns the weekly_period id.
 */
export async function calculateTransfersForWeek(marketId, weekStartStr, isLinenWeek, userId, closureDays = []) {
  const weekDates = getWeekDates(weekStartStr);
  const weekEnd = weekDates[6];

  const offset = getCentralOffset(weekStartStr);
  const beginTime = weekStartStr + 'T00:00:00' + offset;
  const endTime = weekEnd + 'T23:59:59' + getCentralOffset(weekEnd);

  // Get vendors active during this week: not excluded, has Square mapping,
  // and either never departed or departed after the week started.
  const vendors = await sql`
    SELECT * FROM vendors
    WHERE market_id = ${marketId}
      AND is_excluded = FALSE
      AND square_location_id IS NOT NULL
      AND (departed_date IS NULL OR departed_date >= ${weekStartStr})
  `;

  if (vendors.length === 0) {
    throw new Error('No active vendors with Square location mappings found');
  }

  // Look up the existing weekly period (read only). If it's approved,
  // reject BEFORE we fetch anything.
  const [existingWeekPeriod] = await sql`
    SELECT * FROM weekly_periods WHERE market_id = ${marketId} AND week_start = ${weekStartStr}
  `;

  if (existingWeekPeriod && existingWeekPeriod.status === 'approved') {
    throw new Error('This week is approved. Unlock it first to recalculate.');
  }

  // ==========================================================================
  // PHASE 1 — Fetch from Square & compute. Buffered in memory only.
  // ==========================================================================
  const prepared = [];

  for (const vendor of vendors) {
    console.log(`  Fetching data for ${vendor.name}...`);

    const payments = await fetchAllPayments(vendor.square_location_id, beginTime, endTime);
    const orders = await fetchAllOrders(vendor.square_location_id, beginTime, endTime);

    console.log(`    → ${payments.length} payments, ${orders.length} orders`);

    // Initialize day buckets
    const dayData = {};
    for (const date of weekDates) {
      dayData[date] = {
        date,
        dayName: getDayName(date),
        dineInSales: 0,
        deliverySales: 0,
        totalSales: 0,
        squareFees: 0,
        cashCollected: 0,
        tips: 0,
        marketFeeCalc: 0,
        marketFeeApplied: 0,
        dailyTransfer: 0,
        paymentCount: 0,
      };
    }

    // -------------------------------------------------------
    // STEP 1: ORDERS — sales, delivery detection, tips
    // net_amounts already accounts for returns/refunds/discounts
    // -------------------------------------------------------
    for (const order of orders) {
      if (order.state === 'CANCELED' || order.state === 'DRAFT') continue;

      // Handle return orders: skip CUSTOM_AMOUNT refunds — Square Dashboard
      // does NOT subtract these from Net Sales. ITEM returns ARE subtracted.
      if (order.returns && order.returns.length > 0) {
        const returnLineItems = order.returns[0]?.return_line_items || [];
        const isCustomAmountRefund = returnLineItems.length > 0 &&
          returnLineItems.every(li => li.item_type === 'CUSTOM_AMOUNT');

        if (isCustomAmountRefund) continue;
      }

      const localDate = getLocalDate(order.created_at);
      if (!dayData[localDate]) continue;

      const day = dayData[localDate];

      // Calculate net sales from net_amounts (most accurate)
      const netAmounts = order.net_amounts;
      let netSales = 0;
      let tipAmount = 0;

      if (netAmounts) {
        const totalNet = toDollarsRaw(netAmounts.total_money?.amount);
        const taxNet = toDollarsRaw(netAmounts.tax_money?.amount);
        const tipNet = toDollarsRaw(netAmounts.tip_money?.amount);
        const svcNet = toDollarsRaw(netAmounts.service_charge_money?.amount);
        netSales = totalNet - taxNet - tipNet - svcNet;
        tipAmount = tipNet;
      } else {
        const total = toDollarsRaw(order.total_money?.amount);
        const tax = toDollarsRaw(order.total_tax_money?.amount);
        const tip = toDollarsRaw(order.total_tip_money?.amount);
        const svc = toDollarsRaw(order.total_service_charge_money?.amount);
        netSales = total - tax - tip - svc;
        tipAmount = tip;
      }

      if (isDeliveryOrder(order)) {
        day.deliverySales += netSales;
      } else {
        day.dineInSales += netSales;
      }
      day.totalSales += netSales;
      day.tips += tipAmount;
    }

    // -------------------------------------------------------
    // STEP 2: PAYMENTS — cash collected & Square fees only
    // -------------------------------------------------------
    for (const payment of payments) {
      if (payment.status !== 'COMPLETED') continue;

      const localDate = getLocalDate(payment.created_at);
      if (!dayData[localDate]) continue;

      const day = dayData[localDate];
      const processingFee = payment.processing_fee || [];

      const fees = processingFee.reduce((sum, f) => {
        return sum + toDollarsRaw(f.amount_money?.amount);
      }, 0);
      day.squareFees += fees;
      day.paymentCount++;

      if (payment.source_type === 'CASH') {
        const cashAmount = toDollarsRaw(payment.total_money?.amount) - toDollarsRaw(payment.tip_money?.amount);
        const refundedAmount = toDollarsRaw(payment.refunded_money?.amount);
        day.cashCollected += cashAmount - refundedAmount;
      }
    }

    // -------------------------------------------------------
    // STEP 3: Compute fees and daily transfers
    // -------------------------------------------------------
    let weeklyTotalSales = 0;
    let weeklyTotalDineIn = 0;
    let weeklyTotalDelivery = 0;
    let weeklyTotalMarketFee = 0;
    let weeklyTotalSquareFees = 0;
    let weeklyTotalCash = 0;
    let weeklyTotalTips = 0;

    let closureDayCount = 0;

    for (const date of weekDates) {
      const day = dayData[date];
      const isClosure = closureDays.includes(date);
      if (isClosure) closureDayCount++;

      day.dineInSales = round2(day.dineInSales);
      day.deliverySales = round2(day.deliverySales);
      day.totalSales = round2(day.totalSales);
      day.squareFees = round2(day.squareFees);
      day.cashCollected = round2(day.cashCollected);
      day.tips = round2(day.tips);
      day.isClosure = isClosure;

      const percentageFee = day.totalSales * vendor.percentage_rate;

      if (vendor.plan_type === 'STANDARD') {
        day.marketFeeCalc = round2(percentageFee);
        if (isClosure) {
          day.marketFeeApplied = round2(percentageFee);
        } else {
          day.marketFeeApplied = round2(Math.max(vendor.daily_base_rent, percentageFee));
        }
      } else {
        // FLAT and WEEKLY: no daily minimum, just percentage
        day.marketFeeCalc = round2(percentageFee);
        day.marketFeeApplied = day.marketFeeCalc;
      }

      day.dailyTransfer = round2(day.totalSales - day.marketFeeApplied - day.squareFees - day.cashCollected);

      weeklyTotalSales += day.totalSales;
      weeklyTotalDineIn += day.dineInSales;
      weeklyTotalDelivery += day.deliverySales;
      weeklyTotalMarketFee += day.marketFeeApplied;
      weeklyTotalSquareFees += day.squareFees;
      weeklyTotalCash += day.cashCollected;
      weeklyTotalTips += day.tips;
    }

    // -------------------------------------------------------
    // STEP 4: Weekly summary
    // -------------------------------------------------------
    const deliveryFee = round2(weeklyTotalDelivery * vendor.delivery_fee_rate);
    const serviceCharge = round2(weeklyTotalSales * vendor.service_charge_rate);
    const tipsToTransfer = round2(weeklyTotalTips - serviceCharge);

    // WEEKLY plan: check weekly minimum (pro-rate for closure days)
    let weeklyMinimumBump = 0;
    if (vendor.plan_type === 'WEEKLY' && vendor.weekly_minimum > 0) {
      const activeDays = 7 - closureDayCount;
      const proRatedMinimum = activeDays > 0 ? round2(vendor.weekly_minimum * (activeDays / 7)) : 0;
      if (weeklyTotalMarketFee < proRatedMinimum) {
        weeklyMinimumBump = round2(proRatedMinimum - weeklyTotalMarketFee);
        weeklyTotalMarketFee = proRatedMinimum;
      }
    }

    const linenCharge = isLinenWeek ? (vendor.linen_charge || 0) : 0;

    const sumDailyTransfers = weekDates.reduce((sum, d) => sum + dayData[d].dailyTransfer, 0);
    const grossTransfer = round2(sumDailyTransfers - deliveryFee - weeklyMinimumBump);
    const netTransferBeforeCarryover = round2(grossTransfer - linenCharge);

    // Prior balance carryover (read-only query, safe to do outside the TX)
    const [priorBalance] = await sql`
      SELECT ws.balance_due
      FROM weekly_summaries ws
      JOIN weekly_periods wp ON ws.weekly_period_id = wp.id
      WHERE ws.vendor_id = ${vendor.id}
        AND wp.market_id = ${marketId}
        AND wp.week_start < ${weekStartStr}
        AND wp.status = 'approved'
        AND ws.balance_due > 0
      ORDER BY wp.week_start DESC
      LIMIT 1
    `;

    const priorBalanceDue = priorBalance ? round2(priorBalance.balance_due) : 0;
    const netTransfer = round2(netTransferBeforeCarryover - priorBalanceDue);
    const balanceDue = netTransfer < 0 ? round2(Math.abs(netTransfer)) : 0;

    prepared.push({
      vendor,
      dayData,
      weekly: {
        totalSales: round2(weeklyTotalSales),
        totalDineIn: round2(weeklyTotalDineIn),
        totalDelivery: round2(weeklyTotalDelivery),
        totalMarketFee: round2(weeklyTotalMarketFee),
        totalSquareFees: round2(weeklyTotalSquareFees),
        totalCash: round2(weeklyTotalCash),
        totalTips: round2(weeklyTotalTips),
        deliveryFee,
        serviceCharge,
        tipsToTransfer,
        weeklyMinimumBump,
        linenCharge,
        grossTransfer,
        netTransfer,
        priorBalanceDue,
        balanceDue,
      },
    });
  }

  // ==========================================================================
  // PHASE 2 — Commit everything atomically.
  // If this transaction throws, Postgres rolls back and the prior data remains.
  // ==========================================================================
  // Pass closure_days as the actual array; sql.json() at the insert site
  // tags it as JSONB so the round-trip stays an array on subsequent reads.

  const weekPeriodId = await sql.begin(async (sql) => {
    let wpId;
    if (existingWeekPeriod) {
      wpId = existingWeekPeriod.id;
      await sql`DELETE FROM daily_calculations WHERE weekly_period_id = ${wpId}`;
      await sql`
        DELETE FROM adjustments
        WHERE weekly_summary_id IN (
          SELECT id FROM weekly_summaries WHERE weekly_period_id = ${wpId}
        )
      `;
      await sql`DELETE FROM weekly_summaries WHERE weekly_period_id = ${wpId}`;
      await sql`
        UPDATE weekly_periods
           SET is_linen_week = ${isLinenWeek},
               closure_days = ${sql.json(closureDays)},
               calculated_at = now(),
               week_end = ${weekEnd}
         WHERE id = ${wpId}
      `;
    } else {
      const [ins] = await sql`
        INSERT INTO weekly_periods (market_id, week_start, week_end, is_linen_week, closure_days, calculated_at)
        VALUES (${marketId}, ${weekStartStr}, ${weekEnd}, ${isLinenWeek}, ${sql.json(closureDays)}, now())
        RETURNING id
      `;
      wpId = ins.id;
    }

    for (const p of prepared) {
      for (const date of weekDates) {
        const d = p.dayData[date];
        await sql`
          INSERT INTO daily_calculations
            (weekly_period_id, vendor_id, date, dine_in_sales, delivery_sales,
             total_sales, market_fee_calculated, market_fee_applied, square_fees,
             cash_collected, tips, daily_transfer, payment_count, is_closure_day)
          VALUES
            (${wpId}, ${p.vendor.id}, ${date}, ${d.dineInSales}, ${d.deliverySales},
             ${d.totalSales}, ${d.marketFeeCalc}, ${d.marketFeeApplied}, ${d.squareFees},
             ${d.cashCollected}, ${d.tips}, ${d.dailyTransfer}, ${d.paymentCount},
             ${d.isClosure})
        `;
      }

      const w = p.weekly;
      const [summaryRow] = await sql`
        INSERT INTO weekly_summaries
          (weekly_period_id, vendor_id, total_sales, total_dine_in, total_delivery,
           total_market_fee, total_square_fees, total_cash, total_tips,
           delivery_fee, service_charge, tips_to_transfer,
           weekly_minimum_bump, linen_charge, gross_transfer, net_transfer,
           prior_balance_due, balance_due)
        VALUES
          (${wpId}, ${p.vendor.id}, ${w.totalSales}, ${w.totalDineIn}, ${w.totalDelivery},
           ${w.totalMarketFee}, ${w.totalSquareFees}, ${w.totalCash}, ${w.totalTips},
           ${w.deliveryFee}, ${w.serviceCharge}, ${w.tipsToTransfer},
           ${w.weeklyMinimumBump}, ${w.linenCharge}, ${w.grossTransfer}, ${w.netTransfer},
           ${w.priorBalanceDue}, ${w.balanceDue})
        RETURNING id
      `;

      // Auto-create linen adjustment on linen weeks.
      // Signed-adjustment convention: deduction = negative amount.
      if (isLinenWeek && w.linenCharge > 0) {
        await sql`
          INSERT INTO adjustments (weekly_summary_id, type, amount, description, created_by)
          VALUES (${summaryRow.id}, 'linen', ${-w.linenCharge}, 'Weekly linen charge', ${userId})
        `;
      }
    }

    return wpId;
  });

  await auditLog(marketId, userId, 'calculate_week', 'weekly_period', weekPeriodId, {
    week_start: weekStartStr, is_linen_week: isLinenWeek, closure_days: closureDays, vendor_count: vendors.length
  });

  return { weekPeriodId, weekStart: weekStartStr, weekEnd, vendorCount: vendors.length };
}
