import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ProtectedRoute({ children, requiredRole }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>Loading...</div>;
  }

  if (!user) return <Navigate to="/login" replace />;

  // Force password change
  if (user.must_change_password && window.location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  // Role check — bounce to the home page appropriate for the user's actual role.
  if (requiredRole && user.role !== requiredRole) {
    const dest = user.role === 'super_admin' ? '/super'
               : user.role === 'admin'        ? '/admin'
               : '/vendor';
    return <Navigate to={dest} replace />;
  }

  return children;
}
