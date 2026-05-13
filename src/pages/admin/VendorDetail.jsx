import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const fmt = (n) => {
  const v = n || 0;
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${abs}` : `$${abs}`;
};

const ADJ_TYPES = ['linen', 'fine', 'equipment', 'credit', 'deposit', 'other'];

// Display overrides — anything not in here falls back to capitalizing the value.
const ADJ_TYPE_LABELS = {
  deposit: 'Deposits',
};
const adjTypeLabel = (t) => ADJ_TYPE_LABELS[t] || (t.charAt(0).toUpperCase() + t.slice(1));

export default function VendorDetail() {
  const { weekId, vendorId } = useParams();
  const { apiFetch } = useAuth();
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adjType, setAdjType] = useState('other');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjDesc, setAdjDesc] = useState('');
  const [adjLoading, setAdjLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch(`/api/admin/weeks/${weekId}`);
    if (res.ok) {
      const weekData = await res.json();
      const vendor = weekData.vendors.find(v => v.vendor_id === Number(vendorId));
      setData({ week: weekData.week, vendor });
    }
    setLoading(false);
  }, [apiFetch, weekId, vendorId]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAddAdjustment = async (e) => {
    e.preventDefault();
    if (!adjAmount || !data?.vendor) return;
    setAdjLoading(true);

    const res = await apiFetch('/api/admin/adjustments', {
      method: 'POST',
      body: JSON.stringify({
        weekly_summary_id: data.vendor.id,
        type: adjType,
        amount: parseFloat(adjAmount),
        description: adjDesc,
      }),
    });

    if (res.ok) {
      setAdjAmount('');
      setAdjDesc('');
      await loadData();
    }
    setAdjLoading(false);
  };

  const handleDeleteAdj = async (adjId) => {
    if (!confirm('Delete this adjustment?')) return;
    const res = await apiFetch(`/api/admin/adjustments/${adjId}`, { method: 'DELETE' });
    if (res.ok) await loadData();
  };

  if (loading) return <div className="loading-spinner">Loading...</div>;
  if (!data?.vendor) return <div className="alert alert-error">Vendor data not found</div>;

  const { week, vendor } = data;
  const isDraft = week.status === 'draft';

  const getDayName = (dateStr) => {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Chicago' });
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <button className="btn btn-outline btn-sm" onClick={() => navigate(`/admin`)} style={{ marginBottom: '0.5rem' }}>
            ← Back to Dashboard
          </button>
          <h1>{vendor.vendor_name}</h1>
          <p className="text-sm text-muted">
            {vendor.plan_type} plan · {(vendor.percentage_rate * 100).toFixed(0)}% rate
            {vendor.daily_base_rent > 0 && ` · $${vendor.daily_base_rent}/day minimum`}
          </p>
        </div>
        <div>
          <span className={`badge ${week.status === 'approved' ? 'badge-approved' : 'badge-draft'}`}>{week.status}</span>
        </div>
      </div>

      {/* Weekly Summary */}
      <div className="summary-grid">
        <div className="summary-item">
          <div className="label">Total Sales</div>
          <div className="value">{fmt(vendor.total_sales)}</div>
        </div>
        <div className="summary-item">
          <div className="label">Market Fee</div>
          <div className="value negative">{fmt(vendor.total_market_fee)}</div>
        </div>
        <div className="summary-item">
          <div className="label">Square Fees</div>
          <div className="value negative">{fmt(vendor.total_square_fees)}</div>
        </div>
        <div className="summary-item">
          <div className="label">Cash Collected</div>
          <div className="value">{fmt(vendor.total_cash)}</div>
        </div>
        <div className="summary-item">
          <div className="label">Delivery Fee</div>
          <div className="value negative">{fmt(vendor.delivery_fee)}</div>
        </div>
        {vendor.prior_balance_due > 0 && (
          <div className="summary-item">
            <div className="label">Prior Balance Applied</div>
            <div className="value negative">{fmt(-vendor.prior_balance_due)}</div>
          </div>
        )}
        <div className="summary-item">
          <div className="label">Net Transfer</div>
          <div className={`value ${vendor.net_transfer < 0 ? 'negative' : 'positive'}`}>{fmt(vendor.net_transfer)}</div>
        </div>
        {vendor.balance_due > 0 && (
          <div className="summary-item">
            <div className="label">Balance Due (carries forward)</div>
            <div className="value negative">{fmt(vendor.balance_due)}</div>
          </div>
        )}
        <div className="summary-item">
          <div className="label">Tips to Transfer</div>
          <div className="value positive">{fmt(vendor.tips_to_transfer)}</div>
        </div>
        {vendor.weekly_minimum_bump > 0 && (
          <div className="summary-item">
            <div className="label">Weekly Min Bump</div>
            <div className="value negative">{fmt(vendor.weekly_minimum_bump)}</div>
          </div>
        )}
      </div>

      {/* Daily Breakdown Table */}
      <div className="card mb-2">
        <div className="card-header"><h2>Daily Breakdown</h2></div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Date</th>
                <th className="num">Dine-In</th>
                <th className="num">Delivery</th>
                <th className="num">Total Sales</th>
                <th className="num">Market Fee</th>
                <th className="num">Sq. Fees</th>
                <th className="num">Cash</th>
                <th className="num">Tips</th>
                <th className="num">Transfer</th>
              </tr>
            </thead>
            <tbody>
              {(vendor.days || []).map((day) => (
                <tr key={day.date} style={day.is_closure_day ? { background: '#fef2f2' } : {}}>
                  <td>
                    {getDayName(day.date)}
                    {day.is_closure_day ? <span className="badge" style={{ marginLeft: '0.4rem', background: '#fee2e2', color: '#b91c1c', fontSize: '0.65rem', padding: '0.1rem 0.4rem' }}>CLOSED</span> : null}
                  </td>
                  <td>{day.date}</td>
                  <td className="num">{fmt(day.dine_in_sales)}</td>
                  <td className="num">{fmt(day.delivery_sales)}</td>
                  <td className="num">{fmt(day.total_sales)}</td>
                  <td className="num negative">{fmt(day.market_fee_applied)}</td>
                  <td className="num negative">{fmt(day.square_fees)}</td>
                  <td className="num">{fmt(day.cash_collected)}</td>
                  <td className="num">{fmt(day.tips)}</td>
                  <td className={`num ${day.daily_transfer < 0 ? 'negative' : 'positive'}`}>{fmt(day.daily_transfer)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}><strong>Weekly Total</strong></td>
                <td className="num">{fmt(vendor.total_dine_in)}</td>
                <td className="num">{fmt(vendor.total_delivery)}</td>
                <td className="num">{fmt(vendor.total_sales)}</td>
                <td className="num negative">{fmt(vendor.total_market_fee)}</td>
                <td className="num negative">{fmt(vendor.total_square_fees)}</td>
                <td className="num">{fmt(vendor.total_cash)}</td>
                <td className="num">{fmt(vendor.total_tips)}</td>
                <td className={`num ${vendor.gross_transfer < 0 ? 'negative' : 'positive'}`}>{fmt(vendor.gross_transfer)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Adjustments */}
      <div className="card">
        <div className="card-header">
          <h2>Adjustments</h2>
          <span className="text-sm text-muted">
            Total: {fmt((vendor.adjustments || []).reduce((s, a) => s + a.amount, 0))}
          </span>
        </div>
        <div className="card-body">
          {(vendor.adjustments || []).length > 0 ? (
            <table className="data-table mb-2">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Description</th>
                  <th className="num">Amount</th>
                  {isDraft && <th style={{width: '80px'}}></th>}
                </tr>
              </thead>
              <tbody>
                {vendor.adjustments.map((adj) => (
                  <tr key={adj.id}>
                    <td><span className="badge badge-draft">{adjTypeLabel(adj.type)}</span></td>
                    <td>{adj.description || '—'}</td>
                    {/*
                      Signed convention: positive = credit to vendor (green),
                      negative = fine/deduction (red). fmt() renders the sign.
                    */}
                    <td className={`num ${adj.amount < 0 ? 'negative' : 'positive'}`}>{fmt(adj.amount)}</td>
                    {isDraft && (
                      <td>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDeleteAdj(adj.id)}>Delete</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted mb-2">No adjustments for this vendor this week.</p>
          )}

          {isDraft && (
            <>
              <form onSubmit={handleAddAdjustment} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div className="form-group" style={{ marginBottom: 0, minWidth: '120px' }}>
                  <label>Type</label>
                  <select value={adjType} onChange={(e) => setAdjType(e.target.value)}>
                    {ADJ_TYPES.map(t => <option key={t} value={t}>{adjTypeLabel(t)}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 0, width: '120px' }}>
                  <label>Amount ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    placeholder="e.g. -250"
                    required
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: '150px' }}>
                  <label>Description</label>
                  <input type="text" value={adjDesc} onChange={(e) => setAdjDesc(e.target.value)} placeholder="Optional note" />
                </div>
                <button type="submit" className="btn btn-primary btn-sm" disabled={adjLoading}>
                  {adjLoading ? 'Adding...' : 'Add'}
                </button>
              </form>
              <p className="text-sm text-muted" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
                Use a <strong>negative</strong> amount for fines or deductions (e.g. <code>-250</code>) and a <strong>positive</strong> amount for credits or refunds (e.g. <code>100</code>).
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
