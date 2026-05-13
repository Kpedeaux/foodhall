import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV_ITEMS_ADMIN = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/vendors', label: 'Vendors' },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/export', label: 'Export' },
  { to: '/admin/settings', label: 'Settings' },
];

export function AdminLayout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-left">
          <div className="app-logo">St. Roch Market</div>
        </div>
        <nav className="header-nav">
          {NAV_ITEMS_ADMIN.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="header-right">
          <span className="header-user">{user?.username}</span>
          <button className="btn-ghost" onClick={() => navigate('/change-password')}>Password</button>
          <button className="btn-ghost" onClick={handleLogout}>Logout</button>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}

export function VendorLayout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <div className="app-layout">
      <header className="app-header vendor-header">
        <div className="header-left">
          <div className="app-logo">St. Roch Market</div>
        </div>
        <div className="header-right">
          <span className="header-user">{user?.vendor_name || user?.username}</span>
          <button className="btn-ghost" onClick={() => navigate('/change-password')}>Password</button>
          <button className="btn-ghost" onClick={handleLogout}>Logout</button>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
