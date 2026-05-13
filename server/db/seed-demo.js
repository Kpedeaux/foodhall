// LEGACY (SQLite-era): not converted to Postgres yet. Do not run against the new Postgres DB.
/**
 * Demo Market Seed Script
 *
 * Creates a completely isolated demo market with fake vendors and
 * realistic weekly data. Safe to run on a production database —
 * everything is scoped to its own market_id.
 *
 * Usage: node server/db/seed-demo.js
 */

import { initDb, getDb } from './database.js';
import bcrypt from 'bcryptjs';

initDb();
const db = getDb();

// Check if demo market already exists
const existing = db.prepare("SELECT id FROM markets WHERE name = 'Demo Food Hall'").get();
if (existing) {
  console.log('Demo market already exists (id=' + existing.id + '). Delete it first if you want to re-seed.');
  process.exit(0);
}

console.log('Seeding demo market...');

// ============================================================
// 1. Create the demo market
// ============================================================
const marketId = db.prepare(`
  INSERT INTO markets (name, square_environment, default_delivery_fee_rate, default_service_charge_rate)
  VALUES ('Demo Food Hall', 'sandbox', 0.105, 0.02)
`).run().lastInsertRowid;

// ============================================================
// 2. Create demo vendors (5 stalls — diverse plan types)
// ============================================================
const insertVendor = db.prepare(`
  INSERT INTO vendors (market_id, name, square_location_id, plan_type, percentage_rate,
    daily_base_rent, delivery_fee_rate, service_charge_rate, weekly_minimum, linen_charge, active)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

const vendors = [
  { name: 'Bayou Bites',       locId: 'DEMO_LOC_001', plan: 'STANDARD', pct: 0.30, daily: 150, deliv: 0.105, svc: 0.02, wkMin: 0,    linen: 20 },
  { name: 'Crescent Tacos',    locId: 'DEMO_LOC_002', plan: 'STANDARD', pct: 0.28, daily: 125, deliv: 0.105, svc: 0.02, wkMin: 0,    linen: 20 },
  { name: 'NOLA Poke',         locId: 'DEMO_LOC_003', plan: 'FLAT',     pct: 0.25, daily: 0,   deliv: 0.105, svc: 0.02, wkMin: 0,    linen: 15 },
  { name: 'Magnolia Bakehouse', locId: 'DEMO_LOC_004', plan: 'WEEKLY',  pct: 0.22, daily: 0,   deliv: 0.00,  svc: 0.02, wkMin: 800,  linen: 20 },
  { name: 'Freret St. Pizza',  locId: 'DEMO_LOC_005', plan: 'STANDARD', pct: 0.30, daily: 175, deliv: 0.105, svc: 0.02, wkMin: 0,    linen: 20 },
];

const vendorIds = [];
for (const v of vendors) {
  const id = insertVendor.run(
    marketId, v.name, v.locId, v.plan, v.pct, v.daily, v.deliv, v.svc, v.wkMin, v.linen
  ).lastInsertRowid;
  vendorIds.push(id);
}

// ============================================================
// 3. Create users — demo admin + demo vendor (Bayou Bites)
// ============================================================
const demoHash = bcrypt.hashSync('demo1234', 10);

const adminUserId = db.prepare(`
  INSERT INTO users (market_id, username, password_hash, role, email, must_change_password)
  VALUES (?, 'demo-admin', ?, 'admin', 'demo@example.com', 0)
`).run(marketId, demoHash).lastInsertRowid;

db.prepare(`
  INSERT INTO users (market_id, vendor_id, username, password_hash, role, email, must_change_password)
  VALUES (?, ?, 'demo-vendor', ?, 'vendor', 'vendor@example.com', 0)
`).run(marketId, vendorIds[0], demoHash);

// ============================================================
// 4. Generate 4 weeks of realistic fake data
// ============================================================
const round2 = (v) => Math.round(v * 100) / 100;

// Pseudo-random seeded generator for reproducibility
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed % 10000) / 10000;
}
function randBetween(min, max) {
  return min + rand() * (max - min);
}

// Weekly sales profiles per vendor (daily average range)
const profiles = [
  { minDaily: 1800, maxDaily: 3200 },  // Bayou Bites — strong
  { minDaily: 1200, maxDaily: 2400 },  // Crescent Tacos — solid mid
  { minDaily: 900,  maxDaily: 1800 },  // NOLA Poke — moderate
  { minDaily: 600,  maxDaily: 1400 },  // Magnolia Bakehouse — smaller bakery
  { minDaily: 2000, maxDaily: 3500 },  // Freret St. Pizza — top performer
];

// Day-of-week multipliers (Mon=1 is slow, Fri/Sat peak)
const dayMultipliers = [0.7, 0.8, 0.85, 1.0, 1.3, 1.4, 1.1];

// 4 weeks ending before today
const weekStarts = [
  '2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23',
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

for (let w = 0; w < weekStarts.length; w++) {
  const ws = weekStarts[w];
  const isLinen = w % 2 === 0; // every other week
  const closureDays = w === 2 ? [ws.replace(/\d{2}$/, '17')] : []; // Mardi Gras Tuesday closure in week 3

  // Generate week dates
  const weekDates = [];
  const start = new Date(ws + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    weekDates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }
  const weekEnd = weekDates[6];

  const weekId = insertWeek.run(marketId, ws, weekEnd, isLinen ? 1 : 0, JSON.stringify(closureDays), adminUserId).lastInsertRowid;

  for (let vi = 0; vi < vendors.length; vi++) {
    const v = vendors[vi];
    const profile = profiles[vi];
    const vendorId = vendorIds[vi];

    let wkSales = 0, wkDineIn = 0, wkDelivery = 0, wkMarketFee = 0;
    let wkSquareFees = 0, wkCash = 0, wkTips = 0;
    let sumDailyTransfers = 0;

    for (let d = 0; d < 7; d++) {
      const date = weekDates[d];
      const isClosure = closureDays.includes(date);

      // Generate daily numbers
      const baseSales = randBetween(profile.minDaily, profile.maxDaily) * dayMultipliers[d];
      const totalSales = round2(isClosure ? baseSales * 0.1 : baseSales); // minimal if closed (maybe some catering)
      const deliveryPct = randBetween(0.08, 0.18);
      const deliverySales = round2(totalSales * deliveryPct);
      const dineInSales = round2(totalSales - deliverySales);

      const tips = round2(totalSales * randBetween(0.12, 0.20));
      const squareFees = round2(totalSales * 0.026 + (isClosure ? 0 : 0.10)); // ~2.6% + per-txn
      const cashPct = randBetween(0.03, 0.10);
      const cashCollected = round2(totalSales * cashPct);
      const paymentCount = Math.round(totalSales / randBetween(14, 22));

      // Market fee
      const percentageFee = totalSales * v.pct;
      let marketFeeCalc = round2(percentageFee);
      let marketFeeApplied;
      if (v.plan === 'STANDARD') {
        marketFeeApplied = isClosure ? round2(percentageFee) : round2(Math.max(v.daily, percentageFee));
      } else {
        marketFeeApplied = marketFeeCalc;
      }

      const dailyTransfer = round2(totalSales - marketFeeApplied - squareFees - cashCollected);

      insertDaily.run(
        weekId, vendorId, date, dineInSales, deliverySales,
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

    // Round weekly totals
    wkSales = round2(wkSales);
    wkDineIn = round2(wkDineIn);
    wkDelivery = round2(wkDelivery);
    wkMarketFee = round2(wkMarketFee);
    wkSquareFees = round2(wkSquareFees);
    wkCash = round2(wkCash);
    wkTips = round2(wkTips);

    // Weekly-level fees
    const deliveryFee = round2(wkDelivery * v.deliv);
    const serviceCharge = round2(wkSales * v.svc);
    const tipsToTransfer = round2(wkTips - serviceCharge);

    // Weekly minimum bump (WEEKLY plan only)
    let weeklyMinBump = 0;
    if (v.plan === 'WEEKLY' && v.wkMin > 0) {
      const closureCount = closureDays.length;
      const activeDays = 7 - closureCount;
      const proRated = activeDays > 0 ? round2(v.wkMin * (activeDays / 7)) : 0;
      if (wkMarketFee < proRated) {
        weeklyMinBump = round2(proRated - wkMarketFee);
        wkMarketFee = proRated;
      }
    }

    const linenCharge = isLinen ? v.linen : 0;
    const grossTransfer = round2(sumDailyTransfers - deliveryFee - weeklyMinBump);
    const netTransfer = round2(grossTransfer - linenCharge);

    const summaryId = insertSummary.run(
      weekId, vendorId, wkSales, wkDineIn, wkDelivery,
      wkMarketFee, wkSquareFees, wkCash, wkTips,
      deliveryFee, serviceCharge, tipsToTransfer,
      weeklyMinBump, linenCharge, grossTransfer, netTransfer
    ).lastInsertRowid;

    // Add linen adjustment on linen weeks (stored as negative = deduction)
    if (isLinen && linenCharge > 0) {
      insertAdj.run(summaryId, -linenCharge, adminUserId);
    }
  }

  console.log(`  Week ${ws} seeded (${isLinen ? 'linen' : 'standard'}${closureDays.length ? ', closure day' : ''})`);
}

console.log(`
✅ Demo market seeded successfully!

  Market: "Demo Food Hall" (id=${marketId})

  Demo Admin Login:
    Username: demo-admin
    Password: demo1234

  Demo Vendor Login (Bayou Bites):
    Username: demo-vendor
    Password: demo1234

  5 vendors, 4 weeks of data, all approved.
`);