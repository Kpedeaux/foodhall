import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';

const PLAN_TYPES = ['STANDARD', 'FLAT', 'WEEKLY'];

export default function VendorSettings() {
  const { apiFetch } = useAuth();
  const [vendors, setVendors] = useState([]);
  const [unconfigured, setUnconfigured] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // vendor id or 'new'
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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
      active: true, departed_date: '', is_excluded: false,
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

  if (loading) return <div className="loading-spinner">Loading vendors...</div>;

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

      {editing !== null && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing === 'new' ? 'Add Vendor' : 'Edit Vendor'}</h3>
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

              <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
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
                <label className="inline-flex gap-1" style={{ fontSize: '0.875rem', cursor: 'pointer' }}>
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
                  <td className="num">{(v.percentage_rate * 100).toFixed(0)}%</td>
                  <td className="num">${v.daily_base_rent}</td>
                  <td className="num">{(v.delivery_fee_rate * 100).toFixed(1)}%</td>
                  <td className="num">{(v.service_charge_rate * 100).toFixed(0)}%</td>
                  <td className="num">${v.weekly_minimum}</td>
                  <td className="num">${v.linen_charge}</td>
                  <td>
                    {v.is_excluded ? <span className="badge" style={{ background: '#f1f5f9', color: '#64748b' }}>Excluded</span>
                      : isDeparted ? <span className="badge" style={{ background: '#fef2f2', color: '#b91c1c' }}>Departed {v.departed_date}</span>
                        : <span className="badge badge-approved">Active</span>}
                  </td>
                  <td>
                    <button className="btn btn-outline btn-sm" onClick={() => startEdit(v)}>Edit</button>
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
