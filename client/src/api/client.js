/**
 * API client — thin wrapper around fetch for all backend calls.
 */

// In dev, Vite proxies /api → http://localhost:3001/api (see vite.config.js).
// In production, set VITE_API_URL to the full backend URL.
const API_BASE = import.meta.env.VITE_API_URL || '/api';

async function request(path, options = {}) {
  const token = localStorage.getItem('authToken');
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...(options.headers || {})
  };

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({ error: 'Invalid response' }));

  if (!res.ok) {
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  }
  return data;
}

export const api = {
  // Auth
  requestOtp: (mobileNumber) =>
    request('/auth/request-otp', { method: 'POST', body: JSON.stringify({ mobileNumber }) }),

  verifyOtp: (mobileNumber, otp, displayName, bankId) =>
    request('/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ mobileNumber, otp, displayName, bankId })
    }),

  bindKey: (mobileNumber, publicKey, displayName, bankId) =>
    request('/auth/bind-key', {
      method: 'POST',
      body: JSON.stringify({ mobileNumber, publicKey, displayName, bankId })
    }),

  getChallenge: (vpa) =>
    request('/auth/challenge', { method: 'POST', body: JSON.stringify({ vpa }) }),

  verifyChallenge: (vpa, challenge, signature) =>
    request('/auth/verify-challenge', {
      method: 'POST',
      body: JSON.stringify({ vpa, challenge, signature })
    }),

  rotateKey: (newPublicKey) =>
    request('/auth/rotate-key', { method: 'POST', body: JSON.stringify({ newPublicKey }) }),

  getMe: () => request('/auth/me'),

  // Banks
  getBanks: () => request('/banks'),

  // Balance
  getBalance: (vpa) => request(`/balance/${encodeURIComponent(vpa)}`),

  // Transactions
  getTransactions: (page = 1, limit = 20) =>
    request(`/transactions?page=${page}&limit=${limit}`),

  // Settlement (admin)
  runSettlement: () => request('/settlement/run', { method: 'POST' }),
  getSettlementBatches: () => request('/settlement/batches'),
  getLedgerCheck: () => request('/settlement/ledger-check'),

  // Float
  requestFloat: (deviceId) =>
    request('/float/request', { method: 'POST', body: JSON.stringify({ deviceId }) }),
  getFloatStatus: () => request('/float/status'),

  // Health
  health: () => request('/health')
};
