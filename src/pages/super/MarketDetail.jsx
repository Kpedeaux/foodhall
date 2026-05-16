import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function MarketDetail() {
  const { id } = useParams();
  const { apiFetch } = useAuth();
  const navigate = useNavigate();

  const [market, setMarket] = useState(null);
  const [users, setUsers] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [weeks, setWeeks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showAdmin, setShowAdmin] = useState(false);
  const [adminForm, setAdminForm] = useState({ username: '', password: '', email: '' });

  const [showReset, setShowReset] = useState(null); // user object
  const [resetPwd, setResetPwd] = useState('');

  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({});

  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, uRes, vRes, wRes] = await Promise.all([
        apiFetch(`/api/super/markets/${id}`),
        apiFetch(`/api/super/markets/${id}/users`),
        apiFetch(`/api/super/markets/${id}/vendors`),
        apiFetch(`/api/super/markets/${id}/weeks`),
      ]);
      if (mRes.ok) setMarket(await mRes.json());
      if (uRes.ok) setUsers(await uRes.json());
      if (vRes.ok) setVendors(await vRes.json());
      if (wRes.ok) setWeeks(await wRes.json());
    } finally {
      setLoading(false);
    }
  }, [apiFetch, id]);

  useEffect(() => { load(); }, [load]);

  const handleAddAdmin = async () => {
    setSaving(true); setError('');
    try {
      const res = await apiFetch(`/api/super/markets/${id}/users`, {
        method: 'POST',
        body: JSON.stringify(adminForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowAdmin(false);
      setAdminForm({ username: '', password: '', email: '' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!showReset || resetPwd.length < 12) return;
    setSaving(true); setError('');
    try {
      const res = await apiFetch(`/api/super/users/${showReset.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword: resetPwd }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowReset(null);
      setResetPwd('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (user) => {
    if (!confirm(`${user.active ? 'Deactivate' : 'Activate'} ${user.username}?`)) return;
    const res = await apiFetch(`/api/super/users/${user.id}/active`, {
      method: 'PUT',
      body: JSON.stringify({ active: !user.active }),
    });
    if (res.ok) await load();
  };

  const startEdit = () => {
    setEditForm({
      name: market.name,
      default_delivery_fee_rate: market.default_delivery_fee_rate,
      default_service_charge_rate: market.default_service_charge_rate,
      square_environment: market.square_environment,
    });
    setShowEdit(true);
  };

  const handleSaveEdit = async () => {
    setSaving(true); setError('');
    try {
      const res = await apiFetch(`/api/super/markets/${id}`, {
        method: 'PUT',
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowEdit(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-spinner">Loading market...</div>;
  if (!market) return <div className="alert alert-error">Market not found.</div>;

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/super')}>← Back to Markets</button>
      </div>

      <div className="page-header">
        <h1 style={{ margin: 0 }}>{market.name}</h1>
        <button className="btn btn-outline" onClick={startEdit}>Edit Market</button>
      </div>

      {error && <div className="alert alert-error mb-2">{error}</div>}

      <div className="summary-grid" style={{ marginBottom: '1.5rem' }}>
        <div className="summary-item"><div className="label">Square Env</div><div className="value">{market.square_environment}</div></div>
        <div className="summary-item"><div className="label">Delivery Fee Rate</div><div className="value">{(market.default_delivery_fee_rate * 100).toFixed(1)}%</div></div>
        <div className="summary-item"><div className="label">Service Charge Rate</div><div className="value">{(market.default_service_charge_rate * 100).toFixed(1)}%</div></div>
        <div className="summary-item"><div className="label">Active Vendors</div><div className="value">{market.active_vendor_count} / {market.vendor_count}</div></div>
        <div className="summary-item"><div className="label">Approved Weeks</div><div className="value">{market.approved_week_count} / {market.week_count}</div></div>
      </div>

      {/* Users */}
      <div className="card mb-2">
        <div className="card-header">
          <h2>Users</h2>
          <button className="btn btn-primary btn-sm" onClick={() => { setShowAdmin(true); setError(''); }}>+ Add Admin</button>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Username</th><th>Role</th><th>Vendor</th><th>Email</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                <td><strong>{u.username}</strong></td>
                <td><span className={`badge ${u.role === 'admin' ? 'badge-approved' : 'badge-draft'}`}>{u.role}</span></td>
                <td>{u.vendor_name || '—'}</td>
                <td className="text-muted">{u.email || '—'}</td>
                <td>{u.active ? 'Active' : 'Inactive'}{u.must_change_password ? ' (pwd reset)' : ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-outline btn-sm" onClick={() => { setShowReset(u); setResetPwd(''); setError(''); }} style={{ marginRight: '0.25rem' }}>Reset Pwd</button>
                  <button className="btn btn-outline btn-sm" onClick={() => handleToggleActive(u)}>{u.active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: '1rem', color: 'var(--color-text-secondary)' }}>No users in this market.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Vendors — read-only */}
      <div className="card mb-2">
        <div className="card-header"><h2>Vendors (read-only)</h2><span className="text-sm text-muted">{vendors.length} total</span></div>
        <table className="data-table">
          <thead>
            <tr><th>Vendor</th><th>Plan</th><th className="num">% Rate</th><th className="num">Daily Min</th><th>Status</th></tr>
          </thead>
          <tbody>
            {vendors.map(v => (
              <tr key={v.id} style={{ opacity: v.active && !v.is_excluded ? 1 : 0.5 }}>
                <td><strong>{v.name}</strong></td>
                <td>{v.plan_type}</td>
                <td className="num">{(v.percentage_rate * 100).toFixed(0)}%</td>
                <td className="num">${v.daily_base_rent}</td>
                <td>{v.is_excluded ? <span className="badge" style={{ background: '#f1f5f9', color: '#64748b' }}>Excluded</span> : v.departed_date ? <span className="badge" style={{ background: '#fef2f2', color: '#b91c1c' }}>Departed</span> : <span className="badge badge-approved">Active</span>}</td>
              </tr>
            ))}
            {vendors.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: '1rem', color: 'var(--color-text-secondary)' }}>No vendors.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Recent weeks — read-only */}
      <div className="card mb-2">
        <div className="card-header"><h2>Recent Weeks (read-only)</h2><span className="text-sm text-muted">latest 26</span></div>
        <table className="data-table">
          <thead>
            <tr><th>Week</th><th>Status</th><th>Linen</th><th>Approved At</th><th>Calculated At</th></tr>
          </thead>
          <tbody>
            {weeks.map(w => (
              <tr key={w.id}>
                <td>{w.week_start} → {w.week_end}</td>
                <td><span className={`badge ${w.status === 'approved' ? 'badge-approved' : 'badge-draft'}`}>{w.status}</span></td>
                <td>{w.is_linen_week ? <span className="badge badge-linen">Linen</span> : '—'}</td>
                <td className="text-muted">{w.approved_at ? new Date(w.approved_at).toLocaleString() : '—'}</td>
                <td className="text-muted">{w.calculated_at ? new Date(w.calculated_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
            {weeks.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: '1rem', color: 'var(--color-text-secondary)' }}>No weeks yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Add Admin Modal */}
      {showAdmin && (
        <div className="modal-overlay" onClick={() => setShowAdmin(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Add Admin for {market.name}</h3>
              <button className="btn btn-ghost" onClick={() => setShowAdmin(false)} style={{ color: 'var(--color-text)' }}>✕</button>
            </div>
            <div className="modal-body">
              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-group"><label>Username</label><input type="text" value={adminForm.username} onChange={(e) => setAdminForm({ ...adminForm, username: e.target.value })} /></div>
              <div className="form-group"><label>Initial Password (12+ chars)</label><input type="password" value={adminForm.password} onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })} /></div>
              <div className="form-group"><label>Email (optional)</label><input type="email" value={adminForm.email} onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })} /></div>
              <p className="text-sm text-muted">User will be forced to change password on first login.</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowAdmin(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddAdmin} disabled={saving}>{saving ? 'Creating...' : 'Create Admin'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {showReset && (
        <div className="modal-overlay" onClick={() => setShowReset(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Reset Password — {showReset.username}</h3>
              <button className="btn btn-ghost" onClick={() => setShowReset(null)} style={{ color: 'var(--color-text)' }}>✕</button>
            </div>
            <div className="modal-body">
              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-group"><label>New Password (12+ chars)</label><input type="password" value={resetPwd} onChange={(e) => setResetPwd(e.target.value)} /></div>
              <p className="text-sm text-muted">User will be forced to change password on next login.</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowReset(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleReset} disabled={saving || resetPwd.length < 12}>Reset Password</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Market Modal */}
      {showEdit && (
        <div className="modal-overlay" onClick={() => setShowEdit(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Edit {market.name}</h3>
              <button className="btn btn-ghost" onClick={() => setShowEdit(false)} style={{ color: 'var(--color-text)' }}>✕</button>
            </div>
            <div className="modal-body">
              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-group"><label>Name</label><input type="text" value={editForm.name || ''} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
              <div className="form-group"><label>Square Environment</label>
                <select value={editForm.square_environment || 'production'} onChange={(e) => setEditForm({ ...editForm, square_environment: e.target.value })}>
                  <option value="production">production</option>
                  <option value="sandbox">sandbox</option>
                </select>
              </div>
              <div className="form-group"><label>Default Delivery Fee Rate (decimal, e.g. 0.105)</label><input type="number" step="0.001" value={editForm.default_delivery_fee_rate ?? ''} onChange={(e) => setEditForm({ ...editForm, default_delivery_fee_rate: parseFloat(e.target.value) })} /></div>
              <div className="form-group"><label>Default Service Charge Rate (decimal, e.g. 0.02)</label><input type="number" step="0.001" value={editForm.default_service_charge_rate ?? ''} onChange={(e) => setEditForm({ ...editForm, default_service_charge_rate: parseFloat(e.target.value) })} /></div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowEdit(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveEdit} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
