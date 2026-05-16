import React from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function SuperLayout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    navigate('/super/login');
  };

  const isActive = (path) =>
    location.pathname === path || (path !== '/super' && location.pathname.startsWith(path));

  return (
    <div style={{ minHeight: '100vh', background: '#fafaf8' }}>
      <nav style={{
        background: '#1a1a1a',
        color: '#fafafa',
        padding: '0.75rem 2rem',
        borderBottom: '3px solid #6b7c5e',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          maxWidth: '1400px',
          margin: '0 auto',
        }}>
          <div style={{ display: 'flex', gap: '2rem', alignItems: 'center' }}>
            <Link to="/super" style={{
              color: '#fafafa',
              textDecoration: 'none',
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontSize: '1.3rem',
              letterSpacing: '0.08em',
            }}>
              CORE<span style={{ color: '#6b7c5e' }}>RAIL</span>
              <span style={{
                fontSize: '0.7rem',
                marginLeft: '0.75rem',
                padding: '0.15rem 0.5rem',
                background: '#6b7c5e',
                color: '#fafafa',
                borderRadius: '3px',
                letterSpacing: '0.1em',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontWeight: 600,
                verticalAlign: 'middle',
              }}>SUPER</span>
            </Link>
            <Link to="/super" style={{
              color: isActive('/super') && !isActive('/super/markets') ? '#fafafa' : '#9a9a9a',
              textDecoration: 'none',
              fontSize: '0.85rem',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
            }}>Dashboard</Link>
          </div>
          <div style={{
            display: 'flex',
            gap: '1rem',
            alignItems: 'center',
            fontSize: '0.85rem',
          }}>
            <span style={{ color: '#bbb', fontStyle: 'italic' }}>{user?.username}</span>
            <button onClick={handleLogout} style={{
              background: 'transparent',
              border: '1px solid #444',
              color: '#fafafa',
              padding: '0.3rem 0.8rem',
              borderRadius: '3px',
              cursor: 'pointer',
              fontSize: '0.75rem',
              letterSpacing: '0.05em',
            }}>LOGOUT</button>
          </div>
        </div>
      </nav>
      <div style={{ padding: '1.5rem 2rem', maxWidth: '1400px', margin: '0 auto' }}>
        {children}
      </div>
    </div>
  );
}
