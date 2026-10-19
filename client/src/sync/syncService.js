/**
 * Sync Service — Module 8 (client side)
 *
 * Sends pending transactions to the backend Switch and updates local status.
 */

import {
  getPendingSyncTransactions,
  updateTransactionStatus,
  updateWalletMeta,
  TXN_STATUS
} from '../ledger/localLedger';
import { getWalletMeta } from '../ledger/localLedger';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * Sync all pending_sync transactions to the server.
 *
 * @param {string} token - JWT for authenticated balance reconciliation
 * @param {string} vpa - user's VPA (for balance fetch after sync)
 * @param {string} [deviceId] - for float-based reconciliation
 * @returns {{ synced: number, results: Array, newBalance: number|null }}
 */
export async function syncPendingTransactions(token, vpa, deviceId) {
  const pending = await getPendingSyncTransactions();

  if (pending.length === 0) {
    return { synced: 0, results: [], newBalance: null };
  }

  // Extract raw payloads to send
  const payloads = pending.map((t) => t.rawPayload);

  const meta = await getWalletMeta();
  const floatDeviceId = meta.floatDeviceId || deviceId || null;

  let response;
  try {
    response = await fetch(`${API_BASE}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` })
      },
      body: JSON.stringify({
        deviceId: deviceId || 'unknown',
        transactions: payloads,
        floatDeviceId
      })
    });
  } catch (networkErr) {
    // Network failure — do NOT mark transactions as confirmed optimistically.
    // Only update status based on an actual received response.
    throw new Error('Network error during sync. Transactions remain pending.');
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `Sync failed with status ${response.status}`);
  }

  const { results } = await response.json();

  // Update each local transaction based on its result
  const updates = [];
  for (const result of results) {
    let newStatus;
    let message;

    switch (result.respCode) {
      case '00':
        newStatus = TXN_STATUS.CONFIRMED;
        break;
      case '01': // insufficient funds
      case '03': // exceeds offline float
        newStatus = TXN_STATUS.REJECTED_DOUBLE_SPEND;
        message = result.message || 'Insufficient funds or float exceeded';
        break;
      default:
        newStatus = TXN_STATUS.REJECTED;
        message = result.message || `Rejected (code ${result.respCode})`;
    }

    updates.push(updateTransactionStatus(result.txnId, newStatus, message));
  }

  await Promise.all(updates);

  // After sync, fetch authoritative balance from server to reconcile local cache
  let newBalance = null;
  try {
    const balRes = await fetch(`${API_BASE}/balance/${encodeURIComponent(vpa)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (balRes.ok) {
      const balData = await balRes.json();
      newBalance = balData.available;
      await updateWalletMeta({ lastSyncedBalance: newBalance });
    }
  } catch {
    // Balance fetch failing is non-fatal — local computation still works
  }

  return { synced: pending.length, results, newBalance };
}

/**
 * Fetch authoritative balance from server.
 */
export async function fetchServerBalance(vpa, token) {
  const res = await fetch(`${API_BASE}/balance/${encodeURIComponent(vpa)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) throw new Error('Failed to fetch balance');
  return res.json();
}

/**
 * Request an offline float from the server.
 * Called while online (e.g., after login).
 */
export async function requestOfflineFloat(token, deviceId) {
  const res = await fetch(`${API_BASE}/float/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ deviceId })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Float request failed');
  }

  const data = await res.json();

  // Persist float info to walletMeta for offline use
  await updateWalletMeta({
    floatReservedAmount: data.reservedAmount,
    floatExpiresAt: data.expiresAt,
    floatStartingSeq: data.startingSeq,
    floatDeviceId: deviceId,
    floatSpentOffline: data.reused
      ? (await getWalletMeta()).floatSpentOffline || 0
      : 0,
    floatNextSeq: data.startingSeq
  });

  return data;
}
