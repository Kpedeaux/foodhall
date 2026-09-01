// Square API Service — Direct HTTP calls matching existing stroch-transfers patterns

const token = process.env.SQUARE_ACCESS_TOKEN;
const squareBaseUrl = process.env.SQUARE_ENVIRONMENT === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

// ============================================================
// Helpers
// ============================================================

export function toDollars(amountObj) {
  if (!amountObj || amountObj.amount == null) return 0;
  const val = amountObj.amount;
  if (typeof val === 'bigint') return Number(val) / 100;
  return Number(val) / 100;
}

export function toDollarsRaw(cents) {
  if (cents == null) return 0;
  return Number(cents) / 100;
}

export function getLocalDate(timestamp, timezone = 'America/Chicago') {
  return new Date(timestamp).toLocaleDateString('en-CA', { timeZone: timezone });
}

/**
 * Returns the UTC offset string for America/Chicago on a given date,
 * accounting for CDT (-05:00) vs CST (-06:00).
 */
export function getCentralOffset(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(d);
  const tzPart = parts.find(p => p.type === 'timeZoneName');
  const match = tzPart?.value?.match(/GMT([+-]\d+)/);
  const offsetHours = match ? parseInt(match[1]) : -6;
  const sign = offsetHours >= 0 ? '+' : '-';
  const abs = String(Math.abs(offsetHours)).padStart(2, '0');
  return `${sign}${abs}:00`;
}

export function getDayName(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Chicago' });
}

function toLocalDateStr(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return toLocalDateStr(d);
}

export function getWeekDates(weekStartStr) {
  const dates = [];
  const start = new Date(weekStartStr + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    dates.push(toLocalDateStr(d));
  }
  return dates;
}

// ============================================================
// Delivery Detection
// ============================================================
// Classification is by ORDER SOURCE ONLY, mirroring the source filter on the
// Dashboard "Delivery Net Sales (Transfer)" custom report the office reconciles
// against. Fulfillment type is deliberately NOT consulted: a Square Online or
// POS order fulfilled by delivery still counts as dine-in there, and orders
// with no source at all are Register sales (dine-in).

// Source names exactly as they appear in that report's filter list.
const DELIVERY_SOURCES_EXACT = new Set([
  'postmates delivery', 'postmates pickup', 'uber eats delivery',
  'uber eats pickup', 'sauce', 'caviar', 'doordash', 'doordash - caviar',
  'doordash - storefront', 'uber eats', 'uber eats - postmates',
]);

// Fallback substring match so a renamed or newly added platform source still
// lands in the delivery bucket instead of silently inflating dine-in.
const DELIVERY_SOURCES_FUZZY = [
  'doordash', 'uber eats', 'ubereats', 'grubhub', 'postmates',
  'caviar', 'seamless', 'delivery.com', 'chownow', 'toast',
  'ritual', 'slice', 'olo', 'sauce'
];

export function isDeliveryOrder(order) {
  const src = (order.source && order.source.name ? order.source.name : '').toLowerCase();
  if (!src) return false;
  if (DELIVERY_SOURCES_EXACT.has(src)) return true;
  if (src.includes('delivery')) return true;
  return DELIVERY_SOURCES_FUZZY.some(platform => src.includes(platform));
}

/**
 * The day a sale belongs to, as Square's own sales reports assign it: the day
 * the payment was taken (earliest tender), NOT the day the order was closed.
 * Delivery platforms leave orders OPEN for days before bulk-closing them, so
 * closed_at lags the sale by up to several days. Return orders carry no
 * tenders and fall back to closed_at — the day the return was processed —
 * which is also how the Dashboard books returns.
 */
export function getOrderSaleDate(order) {
  let earliest = null;
  if (order.tenders) {
    for (const t of order.tenders) {
      if (t.created_at && (!earliest || t.created_at < earliest)) earliest = t.created_at;
    }
  }
  return getLocalDate(earliest || order.closed_at || order.created_at);
}

// ============================================================
// Square API Calls
// ============================================================

export async function listLocations() {
  if (!token || token === 'your-production-access-token') {
    throw new Error('Square API token not configured');
  }

  const res = await fetch(`${squareBaseUrl}/v2/locations`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Square-Version': '2025-01-23',
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Square API error: ${JSON.stringify(data.errors)}`);
  return (data.locations || []).map(l => ({ id: l.id, name: l.name, status: l.status }));
}

export async function fetchAllPayments(locationId, beginTime, endTime) {
  const allPayments = [];
  let cursor = undefined;
  do {
    let url = `${squareBaseUrl}/v2/payments?location_id=${locationId}&begin_time=${encodeURIComponent(beginTime)}&end_time=${encodeURIComponent(endTime)}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    try {
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Square-Version': '2025-01-23',
        },
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`  Error fetching payments for ${locationId}: ${JSON.stringify(data.errors)}`);
        cursor = undefined;
        continue;
      }
      if (data.payments) allPayments.push(...data.payments);
      cursor = data.cursor;
    } catch (err) {
      console.error(`  Error fetching payments for ${locationId}:`, err.message);
      cursor = undefined;
    }
  } while (cursor);
  return allPayments;
}

export async function fetchAllOrders(locationId, startAt, endAt) {
  const allOrders = [];
  let cursor = undefined;
  do {
    const body = {
      location_ids: [locationId],
      query: {
        // COMPLETED orders windowed by closed_at. Two roles for the calculator:
        // return orders (which close the day the return is processed), and a
        // local cache of already-closed sale orders so only the still-open
        // paid ones need a batch retrieve. Sale orders are ultimately selected
        // via the week's payments and bucketed by payment day — see
        // calculator.js — so this window no longer defines what counts.
        // Square requires sort_field to match the date_time_filter field.
        filter: {
          state_filter: { states: ['COMPLETED'] },
          date_time_filter: {
            closed_at: { start_at: startAt, end_at: endAt }
          }
        },
        sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' }
      }
    };
    if (cursor) body.cursor = cursor;

    try {
      const res = await fetch(`${squareBaseUrl}/v2/orders/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Square-Version': '2025-01-23',
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`  Error fetching orders for ${locationId}: ${JSON.stringify(data.errors)}`);
        cursor = undefined;
        continue;
      }
      if (data.orders) allOrders.push(...data.orders);
      cursor = data.cursor;
    } catch (err) {
      console.error(`  Error fetching orders for ${locationId}:`, err.message);
      cursor = undefined;
    }
  } while (cursor);
  return allOrders;
}

/**
 * Retrieve specific orders by id (the paid-but-not-yet-closed ones the
 * closed_at search can't see). Unlike the windowed fetchers this THROWS on
 * failure: a partial result here would silently drop real sales, and the
 * calculator's phase-1/phase-2 design makes an abort safe.
 */
export async function batchRetrieveOrders(orderIds) {
  const orders = [];
  for (let i = 0; i < orderIds.length; i += 100) {
    const chunk = orderIds.slice(i, i + 100);
    const res = await fetch(`${squareBaseUrl}/v2/orders/batch-retrieve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Square-Version': '2025-01-23',
      },
      body: JSON.stringify({ order_ids: chunk }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Square batch-retrieve error: ${JSON.stringify(data.errors)}`);
    }
    if (data.orders) orders.push(...data.orders);
  }
  return orders;
}
