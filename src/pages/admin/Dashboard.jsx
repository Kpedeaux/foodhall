import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const fmt = (n) => {
  if (n == null) return '$0.00';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
};

function toLocalDateStr(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return toLocalDateStr(d);
}

function addWeeks(dateStr, weeks) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + weeks * 7);
  return toLocalDateStr(d);
}

const TZ = { timeZone: 'America/Chicago' };

function formatWeekRange(start, end) {
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  const sMonth = s.toLocaleDateString('en-US', { month: 'short', ...TZ });
  const eMonth = e.toLocaleDateString('en-US', { month: 'short', ...TZ });
  return `${sMonth} ${s.getDate()} — ${eMonth} ${e.getDate()}, ${e.getFullYear()}`;
}

function getWeekDates(weekStartStr) {
  const dates = [];
  const start = new Date(weekStartStr + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    dates.push(toLocalDateStr(d));
  }
  return dates;
}

function getDayLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', ...TZ });
}

export default function Dashboard() {
  const { apiFetch } = useAuth();
  const navigate = useNavigate();

  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [weekData, setWeekData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [isLinenWeek, setIsLinenWeek] = useState(false);
  const [closureDays, setClosureDays] = useState([]);
  const [earlyCloseDays, setEarlyCloseDays] = useState([]);
  const [error, setError] = useState('');
  const [weeks, setWeeks] = useState([]);

  const weekEnd = addWeeks(weekStart, 0);
  const weekEndDate = (() => {
    const d = new Date(weekStart + 'T12:00:00');
    d.setDate(d.getDate() + 6);
    return toLocalDateStr(d);
  })();

  // Load weeks list
  const loadWeeks = useCallback(async () => {
    const res = await apiFetch('/api/admin/weeks');
    if (res.ok) {
      const data = await res.json();
      setWeeks(data);
    }
  }, [apiFetch]);

  // Load specific week data
  const loadWeekData = useCallback(async (ws) => {
    const existing = weeks.find(w => w.week_start === ws);
    if (!existing) {
      setWeekData(null);
      setClosureDays([]);
      setEarlyCloseDays([]);
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch(`/api/admin/weeks/${existing.id}`);
      if (res.ok) {
        const data = await res.json();
        setWeekData(data);
        setIsLinenWeek(!!data.week?.is_linen_week);
        // Postgres JSONB columns round-trip as arrays via postgres.js,
        // but legacy SQLite rows came over as JSON strings — handle both.
        const parseDays = (v) => {
          if (Array.isArray(v)) return v;
          if (typeof v === 'string' && v.length > 0) {
            try { return JSON.parse(v); } catch { return []; }
          }
          return [];
        };
        setClosureDays(parseDays(data.week?.closure_days));
        setEarlyCloseDays(parseDays(data.week?.early_close_days));
      } else {
        setWeekData(null);
      }
    } catch {
      setWeekData(null);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, weeks]);

  useEffect(() => { loadWeeks(); }, [loadWeeks]);
  useEffect(() => { if (weeks.length > 0) loadWeekData(weekStart); }, [weekStart, weeks, loadWeekData]);

  // Safely parse a Response body that may be empty / non-JSON.
  // The common non-JSON case is an HTML error page returned by a CDN /
  // edge proxy (DO gateway 5xx, Cloudflare 502/504/524, etc.) when the
  // request times out or the origin is unreachable. Dumping the raw HTML
  // into the alert produces an unreadable wall of markup, so we detect
  // HTML, lift the most useful signal (status code + <title> if present),
  // and discard the body.
  const readJsonSafely = async (res) => {
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); }
    catch {
      const looksLikeHtml = /<!DOCTYPE\s+html|<html/i.test(text);
      if (looksLikeHtml) {
        const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : '';
        const detail = title
          ? `HTTP ${res.status} — ${title}`
          : `HTTP ${res.status} from edge proxy`;
        return {
          error: `${detail}. The server didn't return JSON, which usually means the request timed out at the load balancer (~60s on DO App Platform) before the pull finished. Check Runtime Logs and consider re-pulling.`,
        };
      }
      // Plain-text non-JSON (rare) — pass through truncated.
      return { error: text.slice(0, 500) };
    }
  };

  const handlePull = async () => {
    setError('');
    setPulling(true);
    try {
      const res = await apiFetch('/api/admin/weeks/pull', {
        method: 'POST',
        body: JSON.stringify({ weekStart, isLinenWeek, closureDays, earlyCloseDays }),
      });
      const data = await readJsonSafely(res);
      if (!res.ok) {
        throw new Error(
          data?.error ||
          `Pull failed (HTTP ${res.status}). The server may have restarted or lost connection to Square. Your existing data is safe — try again.`
        );
      }
      if (!data) {
        throw new Error('The server did not return a response. Check that the Food Hall server is still running, then try again.');
      }

      await loadWeeks();
      // loadWeekData will fire from weeks change
    } catch (err) {
      setError(err.message);
    } finally {
      setPulling(false);
    }
  };

  const handleApprove = async () => {
    if (!weekData?.week?.id) return;
    if (!confirm('Approve this week? Vendors will be able to see the data.')) return;

    const res = await apiFetch(`/api/admin/weeks/${weekData.week.id}/approve`, { method: 'POST' });
    if (res.ok) {
      await loadWeeks();
    }
  };

  const handleUnlock = async () => {
    if (!weekData?.week?.id) return;
    if (!confirm('Unlock this week? This will allow recalculation and hide it from vendors.')) return;

    const res = await apiFetch(`/api/admin/weeks/${weekData.week.id}/unlock`, { method: 'POST' });
    if (res.ok) {
      await loadWeeks();
    }
  };

  const status = weekData?.week?.status;

  return (
    <div>
      <div className="page-header">
        <h1>Weekly Transfers</h1>
        <div className="actions">
          <div className="week-selector">
            <button className="week-nav-btn" onClick={() => setWeekStart(addWeeks(weekStart, -1))}>&#9664;</button>
            <div className="week-display">{formatWeekRange(weekStart, weekEndDate)}</div>
            <button className="week-nav-btn" onClick={() => setWeekStart(addWeeks(weekStart, 1))}>&#9654;</button>
          </div>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="flex-between mb-2" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <div className="inline-flex gap-1">
          <label className="inline-flex gap-1" style={{ fontSize: '0.875rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={isLinenWeek} onChange={(e) => setIsLinenWeek(e.target.checked)} />
            Linen Week
          </label>
          {status && (
            <span className={`badge ${status === 'approved' ? 'badge-approved' : 'badge-draft'}`}>
              {status}
            </span>
          )}
          {weekData?.week?.is_linen_week ? <span className="badge badge-linen">Linen</span> : null}
        </div>

        <div className="inline-flex gap-1">
          <button className="btn btn-primary" onClick={handlePull} disabled={pulling || status === 'approved'}>
            {pulling ? 'Pulling data...' : 'Pull Square Data'}
          </button>
          {status === 'draft' && (
            <button className="btn btn-success" onClick={handleApprove}>Approve Week</button>
          )}
          {status === 'approved' && (
            <button className="btn btn-warning" onClick={handleUnlock}>Unlock</button>
          )}
        </div>
      </div>

      {/* Closure / Early-close Days */}
      <div className="card mb-2" style={{ padding: '0.75rem 1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.03em', minWidth: '8rem' }}>
            Market Closed
          </span>
          {getWeekDates(weekStart).map(date => {
            const checked = closureDays.includes(date);
            return (
              <label key={date} style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                fontSize: '0.85rem', cursor: status === 'approved' ? 'not-allowed' : 'pointer',
                opacity: status === 'approved' ? 0.6 : 1,
                padding: '0.3rem 0.5rem', borderRadius: '4px',
                background: checked ? 'var(--color-danger-bg)' : 'transparent',
                border: checked ? '1px solid #fecaca' : '1px solid transparent',
              }}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={status === 'approved'}
                  onChange={() => {
                    setClosureDays(prev =>
                      prev.includes(date) ? prev.filter(d => d !== date) : [...prev, date]
                    );
                  }}
                />
                {getDayLabel(date)}
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.03em', minWidth: '8rem' }}>
            Early Close
          </span>
          {getWeekDates(weekStart).map(date => {
            // Closed wins over Early Close: a day already marked Closed can't
            // also be Early Close. We disable the box and visually drop it.
            const isClosed = closureDays.includes(date);
            const checked = !isClosed && earlyCloseDays.includes(date);
            const disabled = status === 'approved' || isClosed;
            return (
              <label key={date} style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                fontSize: '0.85rem', cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.45 : 1,
                padding: '0.3rem 0.5rem', borderRadius: '4px',
                background: checked ? '#fef3c7' : 'transparent',
                border: checked ? '1px solid #fcd34d' : '1px solid transparent',
              }}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    setEarlyCloseDays(prev =>
                      prev.includes(date) ? prev.filter(d => d !== date) : [...prev, date]
                    );
                  }}
                />
                {getDayLabel(date)}
              </label>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="loading-spinner">Loading week data...</div>
      ) : !weekData ? (
        <div className="card">
          <div className="card-body text-center" style={{ padding: '3rem' }}>
            <img
              src="/market-drawing-800.png"
              alt=""
              style={{ width: '300px', opacity: 0.35, marginBottom: '1rem' }}
            />
            <p style={{ color: 'var(--color-text-secondary)' }}>
              No data for this week yet. Click "Pull Square Data" to fetch sales data.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Grand Totals */}
          <div className="summary-grid">
            <div className="summary-item">
              <div className="label">Total Sales</div>
              <div className="value">{fmt(weekData.grandTotals.totalSales)}</div>
            </div>
            <div className="summary-item">
              <div className="label">Market Fees</div>
              <div className="value negative">{fmt(weekData.grandTotals.totalMarketFees)}</div>
            </div>
            <div className="summary-item">
              <div className="label">Delivery Fees</div>
              <div className="value negative">{fmt(weekData.grandTotals.totalDeliveryFees)}</div>
            </div>
            <div className="summary-item">
              <div className="label">Square Fees</div>
              <div className="value negative">{fmt(weekData.grandTotals.totalSquareFees)}</div>
            </div>
            <div className="summary-item">
              <div className="label">Net Transfers</div>
              <div className="value positive">{fmt(weekData.grandTotals.totalTransfers)}</div>
            </div>
            <div className="summary-item">
              <div className="label">Tips to Transfer</div>
              <div className="value positive">{fmt(weekData.grandTotals.totalTips)}</div>
            </div>
          </div>

          {/* Vendor Summary Table */}
          <div className="card">
            <div className="card-header">
              <h2>Vendor Summary</h2>
              <span className="text-sm text-muted">{weekData.vendors.length} vendors</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Plan</th>
                    <th className="num">Total Sales</th>
                    <th className="num">Market Fee</th>
                    <th className="num">Sq. Fees</th>
                    <th className="num">Cash</th>
                    <th className="num">Delivery Fee</th>
                    <th className="num">Gross Transfer</th>
                    <th className="num">Adjustments</th>
                    <th className="num">Net Transfer</th>
                    <th className="num">Balance Due</th>
                    <th className="num">Tips Transfer</th>
                  </tr>
                </thead>
                <tbody>
                  {weekData.vendors.map((v) => {
                    const adjTotal = (v.adjustments || []).reduce((s, a) => s + a.amount, 0);
                    return (
                      <tr
                        key={v.vendor_id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => navigate(`/admin/weeks/${weekData.week.id}/vendor/${v.vendor_id}`)}
                      >
                        <td><strong>{v.vendor_name}</strong></td>
                        <td><span className="text-sm text-muted">{v.plan_type}</span></td>
                        <td className="num">{fmt(v.total_sales)}</td>
                        <td className="num negative">{fmt(v.total_market_fee)}</td>
                        <td className="num negative">{fmt(v.total_square_fees)}</td>
                        <td className="num">{fmt(v.total_cash)}</td>
                        <td className="num negative">{fmt(v.delivery_fee)}</td>
                        <td className={`num ${v.gross_transfer < 0 ? 'negative' : ''}`}>{fmt(v.gross_transfer)}</td>
                        <td className={`num ${adjTotal < 0 ? 'negative' : 'positive'}`}>{adjTotal !== 0 ? fmt(adjTotal) : '—'}</td>
                        <td className={`num ${v.net_transfer < 0 ? 'negative' : 'positive'}`}><strong>{fmt(v.net_transfer)}</strong></td>
                        <td className="num">{v.balance_due > 0 ? <span className="negative">{fmt(v.balance_due)}</span> : '—'}</td>
                        <td className="num positive">{fmt(v.tips_to_transfer)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}><strong>TOTALS</strong></td>
                    <td className="num">{fmt(weekData.grandTotals.totalSales)}</td>
                    <td className="num negative">{fmt(weekData.grandTotals.totalMarketFees)}</td>
                    <td className="num negative">{fmt(weekData.grandTotals.totalSquareFees)}</td>
                    <td className="num">{fmt(weekData.grandTotals.totalCash)}</td>
                    <td className="num negative">{fmt(weekData.grandTotals.totalDeliveryFees)}</td>
                    <td className="num"></td>
                    <td className="num"></td>
                    <td className={`num ${weekData.grandTotals.totalTransfers < 0 ? 'negative' : 'positive'}`}><strong>{fmt(weekData.grandTotals.totalTransfers)}</strong></td>
                    <td className="num"></td>
                    <td className="num positive">{fmt(weekData.grandTotals.totalTips)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
