import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AdminLayout, VendorLayout } from './components/Layout';
import Login from './pages/Login';
import SuperLogin from './pages/super/SuperLogin';
import SuperDashboard from './pages/super/SuperDashboard';
import MarketDetail from './pages/super/MarketDetail';
import { SuperLayout } from './components/SuperLayout';
import ChangePassword from './pages/ChangePassword';
import Dashboard from './pages/admin/Dashboard';
import VendorDetail from './pages/admin/VendorDetail';
import VendorSettings from './pages/admin/VendorSettings';
import UserManagement from './pages/admin/UserManagement';
import MarketSettings from './pages/admin/MarketSettings';
import ExportPage from './pages/admin/ExportPage';
import VendorDashboard from './pages/vendor/VendorDashboard';
import './app.css';

function AppRoutes() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={
        <ProtectedRoute><ChangePassword /></ProtectedRoute>
      } />

      {/* Admin routes */}
      <Route path="/admin" element={
        <ProtectedRoute requiredRole="admin"><AdminLayout><Dashboard /></AdminLayout></ProtectedRoute>
      } />
      <Route path="/admin/weeks/:weekId/vendor/:vendorId" element={
        <ProtectedRoute requiredRole="admin"><AdminLayout><VendorDetail /></AdminLayout></ProtectedRoute>
      } />
      <Route path="/admin/vendors" element={
        <ProtectedRoute requiredRole="admin"><AdminLayout><VendorSettings /></AdminLayout></ProtectedRoute>
      } />
      <Route path="/admin/users" element={
        <ProtectedRoute requiredRole="admin"><AdminLayout><UserManagement /></AdminLayout></ProtectedRoute>
      } />
      <Route path="/admin/export" element={
        <ProtectedRoute requiredRole="admin"><AdminLayout><ExportPage /></AdminLayout></ProtectedRoute>
      } />
      <Route path="/admin/settings" element={
        <ProtectedRoute requiredRole="admin"><AdminLayout><MarketSettings /></AdminLayout></ProtectedRoute>
      } />

      {/* Vendor routes */}
      <Route path="/vendor" element={
        <ProtectedRoute requiredRole="vendor"><VendorLayout><VendorDashboard /></VendorLayout></ProtectedRoute>
      } />
      <Route path="/vendor/weeks/:weekId" element={
        <ProtectedRoute requiredRole="vendor"><VendorLayout><VendorDashboard /></VendorLayout></ProtectedRoute>
      } />

      {/* Super Admin routes */}
      <Route path="/super/login" element={<SuperLogin />} />
      <Route path="/super" element={
        <ProtectedRoute requiredRole="super_admin"><SuperLayout><SuperDashboard /></SuperLayout></ProtectedRoute>
      } />
      <Route path="/super/markets/:id" element={
        <ProtectedRoute requiredRole="super_admin"><SuperLayout><MarketDetail /></SuperLayout></ProtectedRoute>
      } />

      {/* Default redirect */}
      <Route path="/" element={
        user
          ? <Navigate to={user.role === 'super_admin' ? '/super' : user.role === 'admin' ? '/admin' : '/vendor'} replace />
          : <Navigate to="/login" replace />
      } />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
