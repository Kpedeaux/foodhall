import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';

export default function ExportPage() {
  const { apiFetch } = useAuth();
  const [vendors, setVendors] = useState([]);
  const [selectedVendor, setSelectedVendor] = useState('all');
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const res = await apiFetch('/api/admin/vendors');
      if (res.ok) {
        const data = await res.json();
        setVendors(data.vendors.filter(v => v.active));
      }
    })();
  }, [apiFetch]);

  const handleExport = async () => {
    setError('');
    setLoading(true);
    try {
      const url = selectedVendor === 'all'
        ? `/api/export/all/${year}`
        : `/api/export/${selectedVendor}/${year}`;

      const res = await apiFetch(url);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }

      const blob = await res.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = selectedVendor === 'all'
        ? `all_vendors_${year}.xlsx`
        : `vendor_${selectedVendor}_${year}.xlsx`;
      a.click();
      URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="page-header"><h1>Export Annual Reports</h1></div>

      <div className="card" style={{ maxWidth: '500px' }}>
        <div className="card-header"><h2>Generate Excel Report</h2></div>
        <div className="card-body">
          <p className="text-sm text-muted mb-2">
            Export approved weekly data as Excel files for CPA reporting.
            Each file includes Sales Transfers and Tips sheets.
          </p>

          {error && <div className="alert alert-error">{error}</div>}

          <div className="form-group">
            <label>Vendor</label>
            <select value={selectedVendor} onChange={(e) => setSelectedVendor(e.target.value)}>
              <option value="all">All Vendors (one sheet per vendor)</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(parseInt(e.target.value))} min={2020} max={2030} />
          </div>

          <button className="btn btn-primary" onClick={handleExport} disabled={loading}>
            {loading ? 'Generating...' : 'Export .xlsx'}
          </button>
        </div>
      </div>
    </div>
  );
}
