import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const fmt = (n) => {
  const v = n || 0;
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${abs}` : `$${abs}`;
};

const TZ = { timeZone: 'America/Chicago' };

function formatWeekRange(start, end) {
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  const sMonth = s.toLocaleDateString('en-US', { month: 'long', ...TZ });
  const eMonth = e.toLocaleDateString('en-US', { month: 'long', ...TZ });
  if (sMonth === eMonth) {
    return `${sMonth} ${s.getDate()} — ${e.getDate()}, ${e.getFullYear()}`;
  }
  return `${sMonth} ${s.getDate()} — ${eMonth} ${e.getDate()}, ${e.getFullYear()}`;
}

const getDayName = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', ...TZ });
};

export default function VendorDashboard() {
  const { weekId } = useParams();
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();

  const [weeks, setWeeks] = useState([]);
  const [weekDetail, setWeekDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showDaily, setShowDaily] = useState(false);
  const [rankings, setRankings] = useState(null);

  const loadWeeks = useCallback(async () => {
    const res = await apiFetch('/api/vendor/weeks');
    if (res.ok) {
      setWeeks(await res.json());
    }
    setLoading(false);
  }, [apiFetch]);

  useEffect(() => { loadWeeks(); }, [loadWeeks]);

  useEffect(() => {
    if (!weekId && weeks.length > 0) {
      navigate(`/vendor/weeks/${weeks[0].id}`, { replace: true });
    }
  }, [weekId, weeks, navigate]);

  useEffect(() => {
    if (!weekId) return;
    setDetailLoading(true);
    setShowDetails(false);
    setShowDaily(false);
    setRankings(null);

    Promise.all([
      apiFetch(`/api/vendor/weeks/${weekId}`).then(res => res.ok ? res.json() : null),
      apiFetch(`/api/vendor/weeks/${weekId}/rankings`).then(res => res.ok ? res.json() : null),
    ]).then(([detail, rankData]) => {
      setWeekDetail(detail);
      setRankings(rankData);
    }).finally(() => setDetailLoading(false));
  }, [weekId, apiFetch]);

  if (loading) return <div className="loading-spinner">Loading...</div>;

  if (weeks.length === 0) {
    return (
      <div className="card">
        <div className="card-body text-center" style={{ padding: '3rem' }}>
          <img
            src="/market-drawing-800.png"
            alt=""
            style={{ width: '260px', opacity: 0.3, marginBottom: '1rem' }}
          />
          <p style={{ color: 'var(--color-text-secondary)' }}>
            No approved weekly reports available yet.
          </p>
        </div>
      </div>
    );
  }

  const s = weekDetail?.summary;

  // Calculate total adjustments
  const totalAdj = (weekDetail?.adjustments || []).reduce((sum, a) => sum + a.amount, 0);

  return (
    <div>
      {/* Week Selector */}
      <div className="flex-between mb-2" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontFamily: "'Cormorant Garamond', Georgia, serif", fontWeight: 600, letterSpacing: '0.02em' }}>Weekly Report</h1>
        <select
          value={weekId || ''}
          onChange={(e) => navigate(`/vendor/weeks/${e.target.value}`)}
          style={{ padding: '0.5rem 0.75rem', fontSize: '0.9rem' }}
        >
          {weeks.map(w => (
            <option key={w.id} value={w.id}>
              {formatWeekRange(w.week_start, w.week_end)}
            </option>
          ))}
        </select>
      </div>

      {detailLoading ? (
        <div className="loading-spinner">Loading week data...</div>
      ) : !weekDetail ? (
        <p className="text-muted">Select a week to view details.</p>
      ) : (
        <>
          {/* ============================================
              HERO: Transfer Amount — the anchor
              ============================================ */}
          <div style={{
            background: s.net_transfer < 0
              ? 'linear-gradient(135deg, #8b3a3a 0%, #a04040 50%, #b54e4e 100%)'
              : 'linear-gradient(135deg, #5a6b4e 0%, #6b7c5e 50%, #7d8e6e 100%)',
            color: '#faf8f4',
            borderRadius: '8px',
            padding: '2rem 1.5rem',
            textAlign: 'center',
            marginBottom: '1rem',
            boxShadow: s.net_transfer < 0
              ? '0 4px 16px rgba(139, 58, 58, 0.3)'
              : '0 4px 16px rgba(90, 107, 78, 0.3)',
            borderTop: '3px solid #b8a88a',
          }}>
            <div style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: '0.85rem', opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 500,
            }}>
              {s.net_transfer < 0 ? 'Balance Due' : 'Your Transfer'}
            </div>
            <div style={{ fontSize: '2.75rem', fontWeight: 800, lineHeight: 1.1, marginTop: '0.25rem', fontVariantNumeric: 'tabular-nums' }}>
              {fmt(s.net_transfer)}
            </div>
            {s.net_transfer < 0 && (
              <div style={{ fontSize: '0.8rem', opacity: 0.85, marginTop: '0.5rem' }}>
                Fees exceeded sales this week. This balance will be deducted from next week's transfer.
              </div>
            )}
          </div>

          {/* ============================================
              Prior balance applied notice
              ============================================ */}
          {s.prior_balance_due > 0 && (
            <div style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '8px',
              padding: '0.75rem 1.25rem',
              marginBottom: '1rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span style={{ fontSize: '0.85rem', color: '#991b1b' }}>Prior week balance applied</span>
              <span style={{ fontSize: '1rem', fontWeight: 700, color: '#991b1b', fontVariantNumeric: 'tabular-nums' }}>
                {fmt(-s.prior_balance_due)}
              </span>
            </div>
          )}

          {/* ============================================
              Tips — framed as additional money they get
              ============================================ */}
          {s.tips_to_transfer > 0 && (
            <div style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              padding: '1rem 1.25rem',
              marginBottom: '1rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>Tips Transferred</span>
              <span style={{
                fontSize: '1.35rem', fontWeight: 700, color: '#6b7c5e',
                fontVariantNumeric: 'tabular-nums',
              }}>
                +{fmt(s.tips_to_transfer)}
              </span>
            </div>
          )}

          {/* ============================================
              Adjustments (if any) — neutral tone
              Signed convention: negative = deduction, positive = credit.
              Show the block whenever adjustments are non-zero in either direction.
              ============================================ */}
          {totalAdj !== 0 && (
            <div style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              padding: '0.75rem 1.25rem',
              marginBottom: '1rem',
            }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', fontWeight: 600, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                Adjustments
              </div>
              {weekDetail.adjustments.map(adj => (
                <div key={adj.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '0.3rem 0',
                  fontSize: '0.85rem',
                  color: 'var(--color-text-secondary)',
                }}>
                  <span>{adj.description || adj.type.charAt(0).toUpperCase() + adj.type.slice(1)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                    {fmt(adj.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ============================================
              Fee Breakdown — collapsed by default
              ============================================ */}
          <div style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            marginBottom: '1rem',
            overflow: 'hidden',
          }}>
            <button
              onClick={() => setShowDetails(!showDetails)}
              style={{
                width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                padding: '0.85rem 1.25rem',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-secondary)',
              }}
            >
              <span>Fee Breakdown</span>
              <span style={{ fontSize: '0.75rem' }}>{showDetails ? '▲' : '▼'}</span>
            </button>

            {showDetails && (
              <div style={{ padding: '0 1.25rem 1rem', borderTop: '1px solid var(--color-border)' }}>
                {[
                  { label: 'Market Fees', value: s.total_market_fee },
                  { label: 'Square Processing', value: s.total_square_fees },
                  ...(s.delivery_fee > 0 ? [{ label: 'Delivery Fee', value: s.delivery_fee }] : []),
                  ...(s.service_charge > 0 ? [{ label: 'Market Services', value: s.service_charge }] : []),
                  ...(s.prior_balance_due > 0 ? [{ label: 'Prior Week Balance', value: s.prior_balance_due }] : []),
                  ...(s.linen_charge > 0 ? [{ label: 'Linen', value: s.linen_charge }] : []),
                  ...(s.weekly_minimum_bump > 0 ? [{ label: 'Weekly Minimum Adjustment', value: s.weekly_minimum_bump }] : []),
                  ...(s.total_cash > 0 ? [{ label: 'Cash Collected (deducted)', value: s.total_cash }] : []),
                ].map((item, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '0.45rem 0',
                    borderBottom: '1px solid #eae7e0',
                    fontSize: '0.83rem',
                    color: '#9a9a92',
                  }}>
                    <span>{item.label}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                      {fmt(item.value)}
                    </span>
                  </div>
                ))}

                {/* Tips detail inside collapsed section */}
                {s.total_tips > 0 && (
                  <>
                    <div style={{
                      fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)',
                      textTransform: 'uppercase', letterSpacing: '0.03em',
                      marginTop: '0.75rem', marginBottom: '0.25rem',
                    }}>
                      Tips Detail
                    </div>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      padding: '0.35rem 0', fontSize: '0.83rem', color: '#9a9a92',
                      borderBottom: '1px solid #eae7e0',
                    }}>
                      <span>Total Tips</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{fmt(s.total_tips)}</span>
                    </div>
                    {s.service_charge > 0 && (
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        padding: '0.35rem 0', fontSize: '0.83rem', color: '#9a9a92',
                        borderBottom: '1px solid #eae7e0',
                      }}>
                        <span>Market Services</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>-{fmt(s.service_charge)}</span>
                      </div>
                    )}
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      padding: '0.35rem 0', fontSize: '0.83rem', color: '#6b6b65',
                    }}>
                      <span>Tips Transferred</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{fmt(s.tips_to_transfer)}</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ============================================
              Daily Breakdown — collapsed by default
              ============================================ */}
          <div style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            overflow: 'hidden',
          }}>
            <button
              onClick={() => setShowDaily(!showDaily)}
              style={{
                width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                padding: '0.85rem 1.25rem',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-secondary)',
              }}
            >
              <span>Daily Breakdown</span>
              <span style={{ fontSize: '0.75rem' }}>{showDaily ? '▲' : '▼'}</span>
            </button>

            {showDaily && (
              <div style={{ overflowX: 'auto', borderTop: '1px solid var(--color-border)' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th className="num">Sales</th>
                      <th className="num" style={{ color: '#9a9a92' }}>Mkt Fee</th>
                      <th className="num" style={{ color: '#9a9a92' }}>Sq. Fees</th>
                      <th className="num" style={{ color: '#9a9a92' }}>Cash</th>
                      <th className="num">Tips</th>
                      <th className="num" style={{ fontWeight: 700 }}>Transfer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekDetail.days.map(day => (
                      <tr key={day.date}>
                        <td>{getDayName(day.date)}</td>
                        <td className="num">{fmt(day.total_sales)}</td>
                        <td className="num" style={{ color: '#9a9a92' }}>{fmt(day.market_fee_applied)}</td>
                        <td className="num" style={{ color: '#9a9a92' }}>{fmt(day.square_fees)}</td>
                        <td className="num" style={{ color: '#9a9a92' }}>{fmt(day.cash_collected)}</td>
                        <td className="num">{fmt(day.tips)}</td>
                        <td className={`num ${day.daily_transfer < 0 ? 'negative' : 'positive'}`} style={{ fontWeight: 700 }}>{fmt(day.daily_transfer)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td><strong>Total</strong></td>
                      <td className="num">{fmt(s.total_sales)}</td>
                      <td className="num" style={{ color: '#9a9a92' }}>{fmt(s.total_market_fee)}</td>
                      <td className="num" style={{ color: '#9a9a92' }}>{fmt(s.total_square_fees)}</td>
                      <td className="num" style={{ color: '#9a9a92' }}>{fmt(s.total_cash)}</td>
                      <td className="num">{fmt(s.total_tips)}</td>
                      <td className={`num ${s.gross_transfer < 0 ? 'negative' : 'positive'}`} style={{ fontWeight: 700 }}>{fmt(s.gross_transfer)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
          {/* ============================================
              Room Rankings — vendor's position only
              ============================================ */}
          {rankings && rankings.totalVendors > 1 && (
            <div style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              padding: '1.25rem',
              marginTop: '1rem',
            }}>
              <div style={{
                fontWeight: 600, color: 'var(--color-text-secondary)',
                textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem',
                fontFamily: "'Cormorant Garamond', Georgia, serif",
                fontSize: '0.95rem',
              }}>
                Room Rankings
              </div>
              <div style={{ display: 'flex', gap: '1rem' }}>
                {/* Sales rank */}
                {rankings.salesRank && (
                  <div style={{
                    flex: 1, textAlign: 'center',
                    background: 'rgba(107, 124, 94, 0.06)',
                    borderRadius: '8px', padding: '1rem 0.5rem',
                  }}>
                    <div style={{
                      fontSize: '1.75rem', fontWeight: 800, color: '#6b7c5e',
                      fontVariantNumeric: 'tabular-nums', lineHeight: 1,
                    }}>
                      {rankings.salesRank}<span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                        {rankings.salesRank === 1 ? 'st' : rankings.salesRank === 2 ? 'nd' : rankings.salesRank === 3 ? 'rd' : 'th'}
                      </span>
                    </div>
                    <div style={{
                      fontSize: '0.7rem', color: '#9a9a92', marginTop: '0.25rem',
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                    }}>
                      in Sales
                    </div>
                  </div>
                )}
                {/* Transaction rank */}
                {rankings.transactionRank && (
                  <div style={{
                    flex: 1, textAlign: 'center',
                    background: 'rgba(107, 124, 94, 0.06)',
                    borderRadius: '8px', padding: '1rem 0.5rem',
                  }}>
                    <div style={{
                      fontSize: '1.75rem', fontWeight: 800, color: '#6b7c5e',
                      fontVariantNumeric: 'tabular-nums', lineHeight: 1,
                    }}>
                      {rankings.transactionRank}<span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                        {rankings.transactionRank === 1 ? 'st' : rankings.transactionRank === 2 ? 'nd' : rankings.transactionRank === 3 ? 'rd' : 'th'}
                      </span>
                    </div>
                    <div style={{
                      fontSize: '0.7rem', color: '#9a9a92', marginTop: '0.25rem',
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                    }}>
                      in Transactions
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Decorative footer */}
          <div style={{ textAlign: 'center', marginTop: '2.5rem', paddingBottom: '1rem' }}>
            <img
              src="/market-drawing-800.png"
              alt=""
              style={{ width: '220px', opacity: 0.25 }}
            />
          </div>
        </>
      )}
    </div>
  );
}
