import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';

export default function UserManagement() {
  const { apiFetch } = useAuth();
  const [users, setUsers] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showResetModal, setShowResetModal] = useState(null);
  const [form, setForm] = useState({ username: '', password: '', role: 'vendor', vendor_id: '', email: '' });
  const [resetPassword, setResetPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [usersRes, vendorsRes] = await Promise.all([
      apiFetch('/api/admin/users'),
      apiFetch('/api/admin/vendors'),
    ]);
    if (usersRes.ok) setUsers(await usersRes.json());
    if (vendorsRes.ok) {
      const data = await vendorsRes.json();
      setVendors(data.vendors.filter(v => v.active));
    }
    setLoading(false);
  }, [apiFetch]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleCreate = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          vendor_id: form.role === 'vendor' ? parseInt(form.vendor_id) || null : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowModal(false);
      setForm({ username: '', password: '', role: 'vendor', vendor_id: '', email: '' });
      await loadData();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleResetPassword = async () => {
    if (!showResetModal || resetPassword.length < 6) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/admin/users/${showResetModal}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword: resetPassword }),
      });
      if (res.ok) {
        setShowResetModal(null);
        setResetPassword('');
        await loadData();
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (user) => {
    await apiFetch(`/api/admin/users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ active: user.active ? 0 : 1 }),
    });
    await loadData();
  };

  if (loading) return <div className="loading-spinner">Loading users...</div>;

  return (
    <div>
      <div className="page-header">
        <h1>User Management</h1>
        <button className="btn btn-primary" onClick={() => { setShowModal(true); setError(''); }}>Create User</button>
      </div>

      {/* Create User Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Create User</h3>
              <button className="btn btn-ghost" style={{ color: 'var(--color-text)' }} onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-group">
                <label>Username</label>
                <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Password (min 6 characters)</label>
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Email (optional)</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Role</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="vendor">Vendor</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              {form.role === 'vendor' && (
                <div className="form-group">
                  <label>Vendor</label>
                  <select value={form.vendor_id} onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}>
                    <option value="">— Select vendor —</option>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
                {saving ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {showResetModal && (
        <div className="modal-overlay" onClick={() => setShowResetModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Reset Password</h3>
              <button className="btn btn-ghost" style={{ color: 'var(--color-text)' }} onClick={() => setShowResetModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>New Password (min 6 characters)</label>
                <input type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} />
              </div>
              <p className="text-sm text-muted">User will be required to change their password on next login.</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowResetModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleResetPassword} disabled={saving || resetPassword.length < 6}>
                Reset Password
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Vendor</th>
              <th>Email</th>
              <th>Status</th>
              <th></th>
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
                  <button className="btn btn-outline btn-sm" onClick={() => setShowResetModal(u.id)} style={{ marginRight: '0.25rem' }}>Reset Pwd</button>
                  <button className="btn btn-outline btn-sm" onClick={() => toggleActive(u)}>
                    {u.active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
