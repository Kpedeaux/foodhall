import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function SuperDashboard() {
  const { apiFetch } = useAuth();
  const navigate = useNavigate();
  const [markets, setMarkets] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', square_environment: 'production' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, sRes] = await Promise.all([
        apiFetch('/api/super/markets'),
        apiFetch('/api/super/summary'),
      ]);
      if (mRes.ok) setMarkets(await mRes.json());
      if (sRes.ok) setSummary(await sRes.json());
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!form.name.trim()) { setError('Name required'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/super/markets', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create market');
      setShowCreate(false);
      setForm({ name: '', square_environment: 'production' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-spinner">Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <h1 style={{ margin: 0 }}>Markets</h1>
        <button className="btn btn-primary" onClick={() => { setShowCreate(true); setError(''); }}>+ New Market</button>
      </div>

      {summary && (
        <div className="summary-grid" style={{ marginBottom: '1.5rem' }}>
          <div className="summary-item"><div className="label">Markets</div><div className="value">{summary.market_count}</div></div>
          <div className="summary-item"><div className="label">Active Admins</div><div className="value">{summary.active_admin_count}</div></div>
          <div className="summary-item"><div className="label">Active Vendor Users</div><div className="value">{summary.active_vendor_user_count}</div></div>
          <div className="summary-item"><div className="label">Active Vendors</div><div className="value">{summary.active_vendor_count}</div></div>
          <div className="summary-item"><div className="label">Approved Weeks</div><div className="value positive">{summary.approved_weeks}</div></div>
          <div className="summary-item"><div className="label">Draft Weeks</div><div className="value">{summary.draft_weeks}</div></div>
        </div>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Create Market</h3>
              <button className="btn btn-ghost" onClick={() => setShowCreate(false)} style={{ color: 'var(--color-text)' }}>✕</button>
            </div>
            <div className="modal-body">
              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-group">
                <label>Market Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Square Environment</label>
                <select value={form.square_environment} onChange={(e) => setForm({ ...form, square_environment: e.target.value })}>
                  <option value="production">production</option>
                  <option value="sandbox">sandbox</option>
                </select>
              </div>
              <p className="text-sm text-muted">
                After creating, click into the market and use "Add Admin" to provision its first admin user.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
                {saving ? 'Creating...' : 'Create Market'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Market</th>
              <th>Env</th>
              <th className="num">Active Admins</th>
              <th className="num">Active Vendors</th>
              <th>Last Week</th>
              <th>Last Approved</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {markets.map(m => (
              <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/super/markets/${m.id}`)}>
                <td><strong>{m.name}</strong></td>
                <td><span className="text-sm text-muted">{m.square_environment}</span></td>
                <td className="num">{m.active_admin_count}</td>
                <td className="num">{m.active_vendor_count}</td>
                <td>{m.last_week_start || <span className="text-muted">—</span>}</td>
                <td>{m.last_approved_week_start || <span className="text-muted">—</span>}</td>
                <td><button className="btn btn-outline btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/super/markets/${m.id}`); }}>Manage</button></td>
              </tr>
            ))}
            {markets.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-text-secondary)' }}>
                No markets yet. Click "+ New Market" to create one.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
