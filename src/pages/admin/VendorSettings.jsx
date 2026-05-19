import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';

const PLAN_TYPES = ['STANDARD', 'FLAT', 'WEEKLY'];

const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

const fmtPct = (n, digits = 0) => (n == null ? '—' : `${(n * 100).toFixed(digits)}%`);
const fmtMoney = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);

export default function VendorSettings() {
  const { apiFetch } = useAuth();
  const [vendors, setVendors] = useState([]);
  const [unconfigured, setUnconfigured] = useState([]);
  const [loading, setLoading] = useState(true);

  // Edit / create modal
  const [editing, setEditing] = useState(null); // vendor id or 'new'
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Plan history modal
  const [planHistoryFor, setPlanHistoryFor] = useState(null); // vendor object
  const [planHistory, setPlanHistory] = useState([]);
  const [planHistoryLoading, setPlanHistoryLoading] = useState(false);
  const [planError, setPlanError] = useState('');

  // Add-plan-change sub-modal
  const [showAddPlan, setShowAddPlan] = useState(false);
  const [planForm, setPlanForm] = useState({});
  const [planSaving, setPlanSaving] = useState(false);

  const loadVendors = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch('/api/admin/vendors');
    if (res.ok) {
      const data = await res.json();
      setVendors(data.vendors);
      setUnconfigured(data.unconfigured);
    }
    setLoading(false);
  }, [apiFetch]);

  useEffect(() => { loadVendors(); }, [loadVendors]);

  const startEdit = (vendor) => {
    setEditing(vendor ? vendor.id : 'new');
    setForm(vendor ? { ...vendor } : {
      name: '', square_location_id: '', plan_type: 'STANDARD',
      percentage_rate: 0.30, daily_base_rent: 150, delivery_fee_rate: 0.105,
      service_charge_rate: 0.02, weekly_minimum: 0, linen_charge: 20,
      active: true, started_date: '', departed_date: '', is_excluded: false,
    });
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const url = editing === 'new' ? '/api/admin/vendors' : `/api/admin/vendors/${editing}`;
      const method = editing === 'new' ? 'POST' : 'PUT';
      const res = await apiFetch(url, { method, body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEditing(null);
      await loadVendors();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const updateForm = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

  // ── Plan history ─────────────────────────────────────────
  const openPlanHistory = async (vendor) => {
    setPlanHistoryFor(vendor);
    setPlanHistory([]);
    setPlanError('');
    setShowAddPlan(false);
    setPlanHistoryLoading(true);
    try {
      const res = await apiFetch(`/api/admin/vendors/${vendor.id}/plan-history`);
      if (res.ok) setPlanHistory(await res.json());
    } finally {
      setPlanHistoryLoading(false);
    }
  };

  const startAddPlan = () => {
    setShowAddPlan(true);
    setPlanError('');
    // Pre-fill with the vendor's current effective values so the operator
    // only needs to change what's different.
    const v = planHistoryFor;
    setPlanForm({
      effective_from: todayStr(),
      plan_type: v?.plan_type || 'STANDARD',
      percentage_rate: v?.percentage_rate ?? 0.30,
      daily_base_rent: v?.daily_base_rent ?? 150,
      delivery_fee_rate: v?.delivery_fee_rate ?? 0.105,
      service_charge_rate: v?.service_charge_rate ?? 0.02,
      weekly_minimum: v?.weekly_minimum ?? 0,
      linen_charge: v?.linen_charge ?? 0,
    });
  };

  const updatePlanForm = (field, value) => setPlanForm(prev => ({ ...prev, [field]: value }));

  const handleAddPlan = async () => {
    if (!planHistoryFor) return;
    setPlanSaving(true);
    setPlanError('');
    try {
      const res = await apiFetch(`/api/admin/vendors/${planHistoryFor.id}/plan-changes`, {
        method: 'POST',
        body: JSON.stringify(planForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowAddPlan(false);
      // refresh history + vendor list (vendor row's "current" terms may now be stale)
      await Promise.all([openPlanHistory(planHistoryFor), loadVendors()]);
    } catch (err) {
      setPlanError(err.message);
    } finally {
      setPlanSaving(false);
    }
  };

  const handleDeletePlan = async (planId) => {
    if (!planHistoryFor) return;
    if (!confirm('Delete this plan entry? Draft weeks that fell under this entry will use the next-most-recent plan on recalc.')) return;
    setPlanError('');
    try {
      const res = await apiFetch(`/api/admin/vendors/${planHistoryFor.id}/plan-changes/${planId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      await Promise.all([openPlanHistory(planHistoryFor), loadVendors()]);
    } catch (err) {
      setPlanError(err.message);
    }
  };

  if (loading) return <div className="loading-spinner">Loading vendors...</div>;

  const isNew = editing === 'new';

  return (
    <div>
      <div className="page-header">
        <h1>Vendor Settings</h1>
        <button className="btn btn-primary" onClick={() => startEdit(null)}>Add Vendor</button>
      </div>

      {unconfigured.length > 0 && (
        <div className="alert alert-info mb-2">
          <strong>Unconfigured Square locations:</strong> {unconfigured.map(u => u.name).join(', ')}
        </div>
      )}

      {/* ── Edit / Create modal ─────────────────────────────── */}
      {editing !== null && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{isNew ? 'Add Vendor' : `Edit Vendor — ${form.name}`}</h3>
              <button className="btn btn-ghost" style={{ color: 'var(--color-text)' }} onClick={() => setEditing(null)}>✕</button>
            </div>
            <div className="modal-body">
              {error && <div className="alert alert-error">{error}</div>}

              <div className="form-group">
                <label>Name</label>
                <input type="text" value={form.name || ''} onChange={(e) => updateForm('name', e.target.value)} />
              </div>

              <div className="form-group">
                <label>Square Location</label>
                <select value={form.square_location_id || ''} onChange={(e) => updateForm('square_location_id', e.target.value)}>
                  <option value="">— Select —</option>
                  {unconfigured.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  {form.square_location_id && !unconfigured.find(u => u.id === form.square_location_id) && (
                    <option value={form.square_location_id}>(Current: {form.square_location_id})</option>
                  )}
                </select>
              </div>

              {/* Initial plan fields — only shown on Add (not Edit). On Edit, plan
                  changes happen via the Plan History modal so they're date-versioned. */}
              {isNew && (
                <>
                  <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: '0.4rem' }}>
                    Initial Plan (effective from Started Date or today)
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                    <div className="form-group">
                      <label>Plan Type</label>
                      <select value={form.plan_type || 'STANDARD'} onChange={(e) => updateForm('plan_type', e.target.value)}>
                        {PLAN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Percentage Rate</label>
                      <input type="number" step="0.01" value={form.percentage_rate ?? ''} onChange={(e) => updateForm('percentage_rate', parseFloat(e.target.value))} />
                    </div>
                    <div className="form-group">
                      <label>Daily Base Rent ($)</label>
                      <input type="number" step="1" value={form.daily_base_rent ?? ''} onChange={(e) => updateForm('daily_base_rent', parseFloat(e.target.value))} />
                    </div>
                    <div className="form-group">
                      <label>Delivery Fee Rate</label>
                      <input type="number" step="0.001" value={form.delivery_fee_rate ?? ''} onChange={(e) => updateForm('delivery_fee_rate', parseFloat(e.target.value))} />
                    </div>
                    <div className="form-group">
                      <label>Service Charge Rate</label>
                      <input type="number" step="0.001" value={form.service_charge_rate ?? ''} onChange={(e) => updateForm('service_charge_rate', parseFloat(e.target.value))} />
                    </div>
                    <div className="form-group">
                      <label>Weekly Minimum ($)</label>
                      <input type="number" step="1" value={form.weekly_minimum ?? ''} onChange={(e) => updateForm('weekly_minimum', parseFloat(e.target.value))} />
                    </div>
                    <div className="form-group">
                      <label>Linen Charge ($)</label>
                      <input type="number" step="1" value={form.linen_charge ?? ''} onChange={(e) => updateForm('linen_charge', parseFloat(e.target.value))} />
                    </div>
                  </div>
                </>
              )}

              {/* On Edit, show the currently-effective plan read-only with a button
                  to manage history. */}
              {!isNew && (
                <div style={{ background: 'var(--color-bg-subtle, #f7f7f5)', padding: '0.75rem 1rem', borderRadius: '6px', marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
                      Current Plan
                      {form.current_terms_effective_from && (
                        <span style={{ marginLeft: '0.5rem', fontStyle: 'italic', textTransform: 'none', letterSpacing: 0 }}>
                          (effective from {form.current_terms_effective_from})
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => openPlanHistory(form)}
                    >
                      Manage Plan History
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem 1rem', fontSize: '0.85rem' }}>
                    <div><strong>Plan:</strong> {form.plan_type}</div>
                    <div><strong>Rate:</strong> {fmtPct(form.percentage_rate)}</div>
                    <div><strong>Daily Min:</strong> {fmtMoney(form.daily_base_rent)}</div>
                    <div><strong>Delivery:</strong> {fmtPct(form.delivery_fee_rate, 1)}</div>
                    <div><strong>Svc Charge:</strong> {fmtPct(form.service_charge_rate, 0)}</div>
                    <div><strong>Wkly Min:</strong> {fmtMoney(form.weekly_minimum)}</div>
                    <div><strong>Linen:</strong> {fmtMoney(form.linen_charge)}</div>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '0.8rem' }}>Started Date</label>
                  <input
                    type="date"
                    value={form.started_date || ''}
                    onChange={(e) => updateForm('started_date', e.target.value)}
                    style={{ fontSize: '0.85rem' }}
                  />
                  {form.started_date && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ fontSize: '0.75rem', padding: '0.1rem 0.4rem', marginTop: '0.25rem' }}
                      onClick={() => updateForm('started_date', '')}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '0.8rem' }}>Departed Date</label>
                  <input
                    type="date"
                    value={form.departed_date || ''}
                    onChange={(e) => updateForm('departed_date', e.target.value)}
                    style={{ fontSize: '0.85rem' }}
                  />
                  {form.departed_date && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ fontSize: '0.75rem', padding: '0.1rem 0.4rem', marginTop: '0.25rem' }}
                      onClick={() => updateForm('departed_date', '')}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <label className="inline-flex gap-1" style={{ fontSize: '0.875rem', cursor: 'pointer', marginTop: '1.5rem' }}>
                  <input type="checkbox" checked={!!form.is_excluded} onChange={(e) => updateForm('is_excluded', e.target.checked)} />
                  Excluded (market operation)
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Plan History modal ─────────────────────────────── */}
      {planHistoryFor && (
        <div className="modal-overlay" onClick={() => setPlanHistoryFor(null)}>
          <div className="modal" style={{ maxWidth: '900px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Plan History — {planHistoryFor.name}</h3>
              <button className="btn btn-ghost" style={{ color: 'var(--color-text)' }} onClick={() => setPlanHistoryFor(null)}>✕</button>
            </div>
            <div className="modal-body">
              {planError && <div className="alert alert-error">{planError}</div>}
              <p className="text-sm text-muted" style={{ marginTop: 0 }}>
                Each entry's <strong>effective from</strong> date is the Monday on or after which it applies.
                Adding a new entry never changes <strong>approved</strong> weeks — only draft weeks recalc with the new plan.
              </p>

              {planHistoryLoading ? (
                <div className="loading-spinner">Loading…</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Effective From</th>
                      <th>Plan</th>
                      <th className="num">Rate</th>
                      <th className="num">Daily Min</th>
                      <th className="num">Delivery</th>
                      <th className="num">Svc Chg</th>
                      <th className="num">Wkly Min</th>
                      <th className="num">Linen</th>
                      <th>Created By</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {planHistory.map(h => (
                      <tr key={h.id}>
                        <td><strong>{h.effective_from}</strong></td>
                        <td>{h.plan_type}</td>
                        <td className="num">{fmtPct(h.percentage_rate)}</td>
                        <td className="num">{fmtMoney(h.daily_base_rent)}</td>
                        <td className="num">{fmtPct(h.delivery_fee_rate, 1)}</td>
                        <td className="num">{fmtPct(h.service_charge_rate, 0)}</td>
                        <td className="num">{fmtMoney(h.weekly_minimum)}</td>
                        <td className="num">{fmtMoney(h.linen_charge)}</td>
                        <td className="text-sm text-muted">{h.created_by_username || '—'}</td>
                        <td>
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => handleDeletePlan(h.id)}
                            disabled={planHistory.length <= 1}
                            title={planHistory.length <= 1 ? 'Cannot delete the only plan entry' : 'Delete this plan entry'}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                    {planHistory.length === 0 && (
                      <tr><td colSpan={10} style={{ textAlign: 'center', padding: '1rem', color: 'var(--color-text-secondary)' }}>
                        No plan entries yet.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setPlanHistoryFor(null)}>Close</button>
              <button className="btn btn-primary" onClick={startAddPlan}>+ Add Plan Change</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Plan Change sub-modal ──────────────────────── */}
      {showAddPlan && planHistoryFor && (
        <div className="modal-overlay" style={{ zIndex: 1200 }} onClick={() => setShowAddPlan(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Add Plan Change — {planHistoryFor.name}</h3>
              <button className="btn btn-ghost" style={{ color: 'var(--color-text)' }} onClick={() => setShowAddPlan(false)}>✕</button>
            </div>
            <div className="modal-body">
              {planError && <div className="alert alert-error">{planError}</div>}

              <div className="form-group">
                <label>Effective From</label>
                <input type="date" value={planForm.effective_from || ''} onChange={(e) => updatePlanForm('effective_from', e.target.value)} />
                <p className="text-sm text-muted" style={{ marginTop: '0.25rem' }}>
                  Applies to weeks whose start (Monday) is on or after this date. Approved weeks are unaffected.
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="form-group">
                  <label>Plan Type</label>
                  <select value={planForm.plan_type || 'STANDARD'} onChange={(e) => updatePlanForm('plan_type', e.target.value)}>
                    {PLAN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Percentage Rate</label>
                  <input type="number" step="0.01" value={planForm.percentage_rate ?? ''} onChange={(e) => updatePlanForm('percentage_rate', parseFloat(e.target.value))} />
                </div>
                <div className="form-group">
                  <label>Daily Base Rent ($)</label>
                  <input type="number" step="1" value={planForm.daily_base_rent ?? ''} onChange={(e) => updatePlanForm('daily_base_rent', parseFloat(e.target.value))} />
                </div>
                <div className="form-group">
                  <label>Delivery Fee Rate</label>
                  <input type="number" step="0.001" value={planForm.delivery_fee_rate ?? ''} onChange={(e) => updatePlanForm('delivery_fee_rate', parseFloat(e.target.value))} />
                </div>
                <div className="form-group">
                  <label>Service Charge Rate</label>
                  <input type="number" step="0.001" value={planForm.service_charge_rate ?? ''} onChange={(e) => updatePlanForm('service_charge_rate', parseFloat(e.target.value))} />
                </div>
                <div className="form-group">
                  <label>Weekly Minimum ($)</label>
                  <input type="number" step="1" value={planForm.weekly_minimum ?? ''} onChange={(e) => updatePlanForm('weekly_minimum', parseFloat(e.target.value))} />
                </div>
                <div className="form-group">
                  <label>Linen Charge ($)</label>
                  <input type="number" step="1" value={planForm.linen_charge ?? ''} onChange={(e) => updatePlanForm('linen_charge', parseFloat(e.target.value))} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowAddPlan(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddPlan} disabled={planSaving || !planForm.effective_from}>
                {planSaving ? 'Saving…' : 'Save Plan Change'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Vendor list table ──────────────────────────────── */}
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Plan</th>
                <th className="num">Rate</th>
                <th className="num">Daily Min</th>
                <th className="num">Delivery</th>
                <th className="num">Svc Charge</th>
                <th className="num">Wkly Min</th>
                <th className="num">Linen</th>
                <th>Started</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {vendors.map(v => {
                const isDeparted = !!v.departed_date;
                return (
                <tr key={v.id} style={{ opacity: isDeparted ? 0.5 : 1 }}>
                  <td><strong>{v.name}</strong></td>
                  <td>{v.plan_type}</td>
                  <td className="num">{fmtPct(v.percentage_rate)}</td>
                  <td className="num">{fmtMoney(v.daily_base_rent)}</td>
                  <td className="num">{fmtPct(v.delivery_fee_rate, 1)}</td>
                  <td className="num">{fmtPct(v.service_charge_rate, 0)}</td>
                  <td className="num">{fmtMoney(v.weekly_minimum)}</td>
                  <td className="num">{fmtMoney(v.linen_charge)}</td>
                  <td className="text-sm text-muted">{v.started_date || '—'}</td>
                  <td>
                    {v.is_excluded ? <span className="badge" style={{ background: '#f1f5f9', color: '#64748b' }}>Excluded</span>
                      : isDeparted ? <span className="badge" style={{ background: '#fef2f2', color: '#b91c1c' }}>Departed {v.departed_date}</span>
                        : <span className="badge badge-approved">Active</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-outline btn-sm" onClick={() => startEdit(v)} style={{ marginRight: '0.25rem' }}>Edit</button>
                    <button className="btn btn-outline btn-sm" onClick={() => openPlanHistory(v)}>Plans</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
