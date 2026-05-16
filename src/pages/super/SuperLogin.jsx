import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function SuperLogin() {
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
      if (user.role !== 'super_admin') {
        // Don't reveal the user's actual role to attackers — generic message.
        setError('These credentials are not authorized for Super Admin access.');
        return;
      }
      if (user.must_change_password) {
        navigate('/change-password');
      } else {
        navigate('/super');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page" style={{ background: '#1a1a1a' }}>
      <div className="login-card" style={{ border: '1px solid #6b7c5e' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
          <div style={{
            fontFamily: "'Cormorant Garamond', Georgia, serif",
            fontWeight: 700,
            fontSize: '1.6rem',
            letterSpacing: '0.02em',
            color: '#2C2F2A',
          }}>
            CORE<span style={{ color: '#6B7F5E' }}>RAIL</span>
          </div>
          <div style={{
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: '0.7rem',
            color: '#9a9a92',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            marginTop: '0.4rem',
          }}>
            Super Admin · Platform Operator
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
            <label htmlFor="su-username">Username</label>
            <input
              id="su-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="su-password">Password</label>
            <input
              id="su-password"
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
