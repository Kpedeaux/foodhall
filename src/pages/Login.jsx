import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const user = await login(username, password);
      if (user.must_change_password) {
        navigate('/change-password');
      } else if (user.role === 'admin') {
        navigate('/admin');
      } else {
        navigate('/vendor');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginBottom: '0.5rem' }}>
            <svg width="36" height="36" viewBox="0 0 120 120" fill="none">
              <rect x="54" y="10" width="12" height="100" rx="2" fill="#2C2F2A" />
              <rect x="30" y="22" width="60" height="6" rx="1.5" fill="#2C2F2A" />
              <rect x="30" y="57" width="60" height="6" rx="1.5" fill="#2C2F2A" />
              <rect x="30" y="92" width="60" height="6" rx="1.5" fill="#2C2F2A" />
              <circle cx="30" cy="25" r="6" fill="#6B7F5E" />
              <circle cx="30" cy="60" r="6" fill="#6B7F5E" />
              <circle cx="30" cy="95" r="6" fill="#6B7F5E" />
              <circle cx="90" cy="25" r="6" fill="#6B7F5E" />
              <circle cx="90" cy="60" r="6" fill="#6B7F5E" />
              <circle cx="90" cy="95" r="6" fill="#6B7F5E" />
            </svg>
            <span style={{
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontWeight: 700,
              fontSize: '1.6rem',
              letterSpacing: '0.02em',
              color: '#2C2F2A',
            }}>
              CORE<span style={{ color: '#6B7F5E' }}>RAIL</span>
            </span>
          </div>
          <div style={{
            fontFamily: "'Cormorant Garamond', Georgia, serif",
            fontSize: '0.7rem',
            color: '#9a9a92',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            marginTop: '0.15rem',
          }}>
            Operations Infrastructure
          </div>
          <div style={{
            width: '40px',
            height: '2px',
            background: '#6b7c5e',
            margin: '0.6rem auto 0',
          }} />
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
