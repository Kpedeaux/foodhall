import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';

export default function MarketSettings() {
  const { apiFetch } = useAuth();
  const [market, setMarket] = useState(null);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [squareStatus, setSquareStatus] = useState(null);

  useEffect(() => {
    (async () => {
      const res = await apiFetch('/api/admin/market');
      if (res.ok) {
        const data = await res.json();
        setMarket(data);
        setForm(data);
      }
      setLoading(false);

      // Check Square connection
      try {
        const sqRes = await apiFetch('/api/admin/square/locations');
        if (sqRes.ok) {
          const locs = await sqRes.json();
          setSquareStatus({ connected: true, locationCount: locs.length });
        } else {
          setSquareStatus({ connected: false });
        }
      } catch {
        setSquareStatus({ connected: false });
      }
    })();
  }, [apiFetch]);

  const handleSave = async () => {
    setSaving(true);
    setSuccess(false);
    const res = await apiFetch('/api/admin/market', {
      method: 'PUT',
      body: JSON.stringify({
        name: form.name,
        default_delivery_fee_rate: parseFloat(form.default_delivery_fee_rate),
        default_service_charge_rate: parseFloat(form.default_service_charge_rate),
      }),
    });
    if (res.ok) setSuccess(true);
    setSaving(false);
  };

  if (loading) return <div className="loading-spinner">Loading settings...</div>;

  return (
    <div>
      <div className="page-header"><h1>Market Settings</h1></div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', maxWidth: '800px' }}>
        <div className="card">
          <div className="card-header"><h2>Market Configuration</h2></div>
          <div className="card-body">
            {success && <div className="alert alert-success">Settings saved.</div>}

            <div className="form-group">
              <label>Market Name</label>
              <input type="text" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Default Delivery Fee Rate</label>
              <input type="number" step="0.001" value={form.default_delivery_fee_rate ?? ''} onChange={(e) => setForm({ ...form, default_delivery_fee_rate: e.target.value })} />
              <span className="text-sm text-muted">e.g., 0.105 for 10.5%</span>
            </div>
            <div className="form-group">
              <label>Default Service Charge Rate</label>
              <input type="number" step="0.001" value={form.default_service_charge_rate ?? ''} onChange={(e) => setForm({ ...form, default_service_charge_rate: e.target.value })} />
              <span className="text-sm text-muted">e.g., 0.02 for 2%</span>
            </div>

            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><h2>Square Connection</h2></div>
          <div className="card-body">
            {squareStatus ? (
              squareStatus.connected ? (
                <div>
                  <div className="alert alert-success">Connected to Square API</div>
                  <p className="text-sm">{squareStatus.locationCount} locations found</p>
                </div>
              ) : (
                <div className="alert alert-error">
                  Not connected. Check your SQUARE_ACCESS_TOKEN in .env
                </div>
              )
            ) : (
              <p className="text-muted">Checking connection...</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
