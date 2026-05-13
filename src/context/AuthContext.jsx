import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('fhm_token'));
  const [loading, setLoading] = useState(true);
  const refreshingRef = useRef(false);

  // ── Token refresh ───────────────────────────────────────────
  // When we get a TOKEN_EXPIRED response, attempt a silent refresh
  // using the stored refresh token before giving up.
  const attemptRefresh = useCallback(async () => {
    if (refreshingRef.current) return null;
    refreshingRef.current = true;

    const refreshToken = localStorage.getItem('fhm_refresh_token');
    if (!refreshToken) {
      refreshingRef.current = false;
      return null;
    }

    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) {
        // Refresh token is also expired/invalid — full logout
        localStorage.removeItem('fhm_token');
        localStorage.removeItem('fhm_refresh_token');
        setToken(null);
        setUser(null);
        return null;
      }

      const data = await res.json();
      localStorage.setItem('fhm_token', data.token);
      setToken(data.token);
      return data.token;
    } catch {
      return null;
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  const apiFetch = useCallback(async (url, options = {}) => {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res = await fetch(url, { ...options, headers });

    // If token expired, try refreshing once
    if (res.status === 401) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.code === 'TOKEN_EXPIRED') {
        const newToken = await attemptRefresh();
        if (newToken) {
          // Retry original request with new token
          headers['Authorization'] = `Bearer ${newToken}`;
          res = await fetch(url, { ...options, headers });
          if (res.ok) return res;
        }
      }

      // Still 401 after refresh attempt — force logout
      localStorage.removeItem('fhm_token');
      localStorage.removeItem('fhm_refresh_token');
      setToken(null);
      setUser(null);
      return res;
    }

    return res;
  }, [token, attemptRefresh]);

  // Verify token on mount
  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    apiFetch('/api/auth/me')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) setUser(data);
        else {
          localStorage.removeItem('fhm_token');
          localStorage.removeItem('fhm_refresh_token');
          setToken(null);
        }
      })
      .catch(() => {
        localStorage.removeItem('fhm_token');
        localStorage.removeItem('fhm_refresh_token');
        setToken(null);
      })
      .finally(() => setLoading(false));
  }, [token, apiFetch]);

  const login = async (username, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    localStorage.setItem('fhm_token', data.token);
    if (data.refreshToken) {
      localStorage.setItem('fhm_refresh_token', data.refreshToken);
    }
    setToken(data.token);
    setUser(data.user);
    return data.user;
  };

  const logout = () => {
    localStorage.removeItem('fhm_token');
    localStorage.removeItem('fhm_refresh_token');
    setToken(null);
    setUser(null);
  };

  const clearMustChangePassword = () => {
    if (user) setUser({ ...user, must_change_password: false });
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, apiFetch, clearMustChangePassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
