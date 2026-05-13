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

const DELIVERY_SOURCES = [
  'doordash', 'uber eats', 'ubereats', 'grubhub', 'postmates',
  'caviar', 'seamless', 'delivery.com', 'chownow', 'toast',
  'ritual', 'slice', 'olo', 'sauce'
];

export function isDeliveryOrder(order) {
  if (order.fulfillments) {
    for (const f of order.fulfillments) {
      if (f.type === 'DELIVERY') return true;
    }
  }
  if (order.source && order.source.name) {
    const src = order.source.name.toLowerCase();
    if (src.includes('delivery')) return true;
    for (const platform of DELIVERY_SOURCES) {
      if (src.includes(platform)) return true;
    }
  }
  return false;
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
        filter: {
          date_time_filter: {
            created_at: { start_at: startAt, end_at: endAt }
          }
        }
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
