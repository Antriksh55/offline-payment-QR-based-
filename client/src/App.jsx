/**
 * App root — wires authentication, routing, and silent login.
 *
 * Navigation is state-based (no router library) since this is a single-flow
 * mobile-style app: register → dashboard → send/receive/admin.
 */

import { useState, useEffect } from 'react';
import { useAuth } from './hooks/useAuth';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import SendPage from './pages/SendPage';
import ReceivePage from './pages/ReceivePage';
import AdminPage from './pages/AdminPage';
import { requestOfflineFloat } from './sync/syncService';
import { getOrCreateKeypair } from './identity/keyStore';
import './styles/global.css';

// Stable device ID — persisted in localStorage (not sensitive)
function getDeviceId() {
  let id = localStorage.getItem('deviceId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('deviceId', id);
  }
  return id;
}

const PAGES = {
  REGISTER: 'register',
  DASHBOARD: 'dashboard',
  SEND: 'send',
  RECEIVE: 'receive',
  ADMIN: 'admin'
};

export default function App() {
  const { isAuthenticated, user, loading, login, logout, trySilentLogin } = useAuth();
  const [page, setPage] = useState(PAGES.DASHBOARD);
  const [deviceId] = useState(getDeviceId);
  const [silentLoginChecked, setSilentLoginChecked] = useState(false);

  // On mount: attempt silent login (same-device keypair challenge)
  useEffect(() => {
    if (!loading) {
      if (!isAuthenticated) {
        trySilentLogin().finally(() => setSilentLoginChecked(true));
      } else {
        setSilentLoginChecked(true);
      }
    }
  }, [loading, isAuthenticated, trySilentLogin]);

  // After login, pre-fetch an offline float in the background
  useEffect(() => {
    if (isAuthenticated && user?.token) {
      requestOfflineFloat(user.token, deviceId).catch((err) => {
        console.info('[Float] Could not pre-fetch float:', err.message);
      });
    }
  }, [isAuthenticated, user?.token, deviceId]);

  const handleLogin = (token, vpa, displayName) => {
    login(token, vpa, displayName);
    setPage(PAGES.DASHBOARD);
  };

  const handleLogout = () => {
    logout();
    setPage(PAGES.DASHBOARD);
  };

  // Show loading spinner while checking auth
  if (loading || !silentLoginChecked) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" aria-label="Loading" />
        <p>Starting up…</p>
      </div>
    );
  }

  // Not authenticated → show registration/login
  if (!isAuthenticated) {
    return <RegisterPage onLogin={handleLogin} />;
  }

  // Authenticated → main app
  return (
    <div className="app-root">
      {page === PAGES.DASHBOARD && (
        <DashboardPage
          user={user}
          deviceId={deviceId}
          onNavigate={(p) => setPage(p)}
          onLogout={handleLogout}
        />
      )}
      {page === PAGES.SEND && (
        <SendPage
          user={user}
          deviceId={deviceId}
          onBack={() => setPage(PAGES.DASHBOARD)}
        />
      )}
      {page === PAGES.RECEIVE && (
        <ReceivePage
          user={user}
          onBack={() => setPage(PAGES.DASHBOARD)}
        />
      )}
      {page === PAGES.ADMIN && (
        <AdminPage
          user={user}
          onBack={() => setPage(PAGES.DASHBOARD)}
        />
      )}

      {/* Bottom nav — only shown on dashboard */}
      {page === PAGES.DASHBOARD && (
        <nav className="bottom-nav">
          <button
            className={`nav-btn ${page === PAGES.DASHBOARD ? 'active' : ''}`}
            onClick={() => setPage(PAGES.DASHBOARD)}
            aria-label="Dashboard"
          >
            <span className="nav-icon">🏠</span>
            <span>Home</span>
          </button>
          <button
            className="nav-btn"
            onClick={() => setPage(PAGES.SEND)}
            aria-label="Send money"
          >
            <span className="nav-icon">↑</span>
            <span>Send</span>
          </button>
          <button
            className="nav-btn"
            onClick={() => setPage(PAGES.RECEIVE)}
            aria-label="Receive money"
          >
            <span className="nav-icon">↓</span>
            <span>Receive</span>
          </button>
          <button
            className="nav-btn"
            onClick={() => setPage(PAGES.ADMIN)}
            aria-label="Admin panel"
          >
            <span className="nav-icon">⚙</span>
            <span>Admin</span>
          </button>
        </nav>
      )}
    </div>
  );
}
