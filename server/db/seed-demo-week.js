/**
 * Add additional demo weeks to the Demo Food Hall.
 *
 * Usage: node server/db/seed-demo-week.js
 */

import { initDb, getDb } from './database.js';

initDb();
const db = getDb();

const market = db.prepare("SELECT id FROM markets WHERE name = 'Demo Food Hall'").get();
if (!market) {
  console.log('Demo market not found. Run seed-demo.js first.');
  process.exit(1);
}
const marketId = market.id;

const adminUser = db.prepare("SELECT id FROM users WHERE username = 'demo-admin' AND market_id = ?").get(marketId);
const adminUserId = adminUser.id;

const vendors = db.prepare("SELECT * FROM vendors WHERE market_id = ? AND is_excluded = 0").all(marketId);

const round2 = (v) => Math.round(v * 100) / 100;

let seed = 9999;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed % 10000) / 10000;
}
function randBetween(min, max) {
  return min + rand() * (max - min);
}

// Sales profiles keyed by vendor order
const profiles = [
  { minDaily: 1800, maxDaily: 3200 },  // Bayou Bites
  { minDaily: 1200, maxDaily: 2400 },  // Crescent Tacos
  { minDaily: 900,  maxDaily: 1800 },  // NOLA Poke
  { minDaily: 600,  maxDaily: 1400 },  // Magnolia Bakehouse
  { minDaily: 2000, maxDaily: 3500 },  // Freret St. Pizza
];

const dayMultipliers = [0.7, 0.8, 0.85, 1.0, 1.3, 1.4, 1.1];

// Weeks to add — add any new weeks here
const newWeeks = [
  { start: '2026-02-23', isLinen: false, closureDays: [] },
];

const insertWeek = db.prepare(`
  INSERT INTO weekly_periods (market_id, week_start, week_end, is_linen_week, closure_days, status, calculated_at, approved_by, approved_at)
  VALUES (?, ?, ?, ?, ?, 'approved', datetime('now'), ?, datetime('now'))
`);

const insertDaily = db.prepare(`
  INSERT INTO daily_calculations (weekly_period_id, vendor_id, date, dine_in_sales, delivery_sales,
    total_sales, market_fee_calculated, market_fee_applied, square_fees, cash_collected, tips,
    daily_transfer, payment_count, is_closure_day)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertSummary = db.prepare(`
  INSERT INTO weekly_summaries (weekly_period_id, vendor_id, total_sales, total_dine_in, total_delivery,
    total_market_fee, total_square_fees, total_cash, total_tips, delivery_fee, service_charge,
    tips_to_transfer, weekly_minimum_bump, linen_charge, gross_transfer, net_transfer)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAdj = db.prepare(`
  INSERT INTO adjustments (weekly_summary_id, type, amount, description, created_by)
  VALUES (?, 'linen', ?, 'Weekly linen charge', ?)
`);

for (const wk of newWeeks) {
  // Check if already exists
  const exists = db.prepare("SELECT id FROM weekly_periods WHERE market_id = ? AND week_start = ?").get(marketId, wk.start);
  if (exists) {
    console.log(`Week ${wk.start} already exists, skipping.`);
    continue;
  }

  const weekDates = [];
  const startDate = new Date(wk.start + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    weekDates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }
  const weekEnd = weekDates[6];

  const weekId = insertWeek.run(marketId, wk.start, weekEnd, wk.isLinen ? 1 : 0, JSON.stringify(wk.closureDays), adminUserId).lastInsertRowid;

  for (let vi = 0; vi < vendors.length; vi++) {
    const v = vendors[vi];
    const profile = profiles[vi] || profiles[0];

    let wkSales = 0, wkDineIn = 0, wkDelivery = 0, wkMarketFee = 0;
    let wkSquareFees = 0, wkCash = 0, wkTips = 0, sumDailyTransfers = 0;

    for (let d = 0; d < 7; d++) {
      const date = weekDates[d];
      const isClosure = wk.closureDays.includes(date);

      const baseSales = randBetween(profile.minDaily, profile.maxDaily) * dayMultipliers[d];
      const totalSales = round2(isClosure ? baseSales * 0.1 : baseSales);
      const deliveryPct = randBetween(0.08, 0.18);
      const deliverySales = round2(totalSales * deliveryPct);
      const dineInSales = round2(totalSales - deliverySales);

      const tips = round2(totalSales * randBetween(0.12, 0.20));
      const squareFees = round2(totalSales * 0.026 + (isClosure ? 0 : 0.10));
      const cashCollected = round2(totalSales * randBetween(0.03, 0.10));
      const paymentCount = Math.round(totalSales / randBetween(14, 22));

      const percentageFee = totalSales * v.percentage_rate;
      const marketFeeCalc = round2(percentageFee);
      let marketFeeApplied;
      if (v.plan_type === 'STANDARD') {
        marketFeeApplied = isClosure ? round2(percentageFee) : round2(Math.max(v.daily_base_rent, percentageFee));
      } else {
        marketFeeApplied = marketFeeCalc;
      }

      const dailyTransfer = round2(totalSales - marketFeeApplied - squareFees - cashCollected);

      insertDaily.run(
        weekId, v.id, date, dineInSales, deliverySales,
        totalSales, marketFeeCalc, marketFeeApplied, squareFees,
        cashCollected, tips, dailyTransfer, paymentCount, isClosure ? 1 : 0
      );

      wkSales += totalSales;
      wkDineIn += dineInSales;
      wkDelivery += deliverySales;
      wkMarketFee += marketFeeApplied;
      wkSquareFees += squareFees;
      wkCash += cashCollected;
      wkTips += tips;
      sumDailyTransfers += dailyTransfer;
    }

    wkSales = round2(wkSales);
    wkDineIn = round2(wkDineIn);
    wkDelivery = round2(wkDelivery);
    wkMarketFee = round2(wkMarketFee);
    wkSquareFees = round2(wkSquareFees);
    wkCash = round2(wkCash);
    wkTips = round2(wkTips);

    const deliveryFee = round2(wkDelivery * v.delivery_fee_rate);
    const serviceCharge = round2(wkSales * v.service_charge_rate);
    const tipsToTransfer = round2(wkTips - serviceCharge);

    let weeklyMinBump = 0;
    if (v.plan_type === 'WEEKLY' && v.weekly_minimum > 0) {
      const activeDays = 7 - wk.closureDays.length;
      const proRated = activeDays > 0 ? round2(v.weekly_minimum * (activeDays / 7)) : 0;
      if (wkMarketFee < proRated) {
        weeklyMinBump = round2(proRated - wkMarketFee);
        wkMarketFee = proRated;
      }
    }

    const linenCharge = wk.isLinen ? v.linen_charge : 0;
    const grossTransfer = round2(sumDailyTransfers - deliveryFee - weeklyMinBump);
    const netTransfer = round2(grossTransfer - linenCharge);

    const summaryId = insertSummary.run(
      weekId, v.id, wkSales, wkDineIn, wkDelivery,
      wkMarketFee, wkSquareFees, wkCash, wkTips,
      deliveryFee, serviceCharge, tipsToTransfer,
      weeklyMinBump, linenCharge, grossTransfer, netTransfer
    ).lastInsertRowid;

    // Linen adjustment stored as negative = deduction (signed convention)
    if (wk.isLinen && linenCharge > 0) {
      insertAdj.run(summaryId, -linenCharge, adminUserId);
    }
  }

  console.log(`  ✅ Week ${wk.start} → ${weekEnd} seeded`);
}

console.log('\nDone! Restart the dev server to see the new data.');
