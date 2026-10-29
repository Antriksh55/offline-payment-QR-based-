/**
 * Sync Service — Module 8 (client side)
 *
 * Sends pending transactions to the backend Switch and updates local status.
 */

import {
  getPendingSyncTransactions,
  updateTransactionStatus,
  updateWalletMeta,
  TXN_STATUS,
  confirmSentTransaction
} from '../ledger/localLedger';
import { getWalletMeta } from '../ledger/localLedger';
import { checkAck, clearAck } from '../transaction/ackService';
import { openDB } from '../identity/keyStore';

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

  // Extract raw payloads — filter out any with empty receiverVpa.
  // A sent transaction has receiverVpa='' until the receiver scans it;
  // If such a transaction somehow ended up as PENDING_SYNC (sender confirmed
  // before receiver actually scanned), revert it to PENDING_SCAN so it doesn't
  // stay stuck as "Pending" forever.
  const validPending = [];
  const invalidPending = [];

  for (const t of pending) {
    const p = t.rawPayload;
    if (p && p.txnId && p.senderVpa && p.receiverVpa && p.amount && p.nonce) {
      validPending.push(t);
    } else {
      invalidPending.push(t);
    }
  }

  // Revert invalid transactions back to PENDING_SCAN — they can't be synced
  // without a receiverVpa, and they shouldn't count as pending balance either
  for (const t of invalidPending) {
    // Before reverting, check if there's an ack with the receiver VPA.
    // This recovers transactions where ack arrived while polling was inactive.
    const ack = await checkAck(t.txnId);
    if (ack?.status === 'accepted' && ack.receiverVpa) {
      await confirmSentTransaction(t.txnId, ack.receiverVpa);
      clearAck(t.txnId);
      // Re-read the now-valid entry from IndexedDB
      const db = await openDB();
      const recovered = await new Promise((res) => {
        const idbTx = db.transaction('localTransactions', 'readonly');
        const req = idbTx.objectStore('localTransactions').get(t.txnId);
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
      });
      if (recovered?.rawPayload?.receiverVpa) {
        validPending.push(recovered);
      }
    } else {
      // Genuinely missing receiverVpa — revert to PENDING_SCAN
      await updateTransactionStatus(
        t.txnId,
        TXN_STATUS.PENDING_SCAN,
        'Reverted: receiver VPA missing — QR not scanned yet'
      );
    }
  }

  const validPayloads = validPending.map((t) => t.rawPayload);

  if (validPayloads.length === 0) {
    return { synced: 0, results: [], newBalance: null };
  }

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
        transactions: validPayloads,
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
      // Use `balance` (credits - debits), NOT `available` (balance - holds).
      // Storing `available` would double-count any active offline float HOLD.
      newBalance = balData.balance ?? balData.available;
      await updateWalletMeta({ lastSyncedBalance: newBalance });
    }
  } catch {
    // Balance fetch failing is non-fatal — local computation still works
  }

  return { synced: validPending.length, results, newBalance };
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

  // Persist float info to walletMeta for offline use.
  // IMPORTANT: only write float-specific keys — never touch lastSyncedBalance here,
  // that is managed exclusively by the balance fetch on login and after sync.
  const currentMeta = await getWalletMeta();
  await updateWalletMeta({
    floatReservedAmount: data.reservedAmount,
    floatExpiresAt: data.expiresAt,
    floatStartingSeq: data.startingSeq,
    floatDeviceId: deviceId,
    // Preserve existing spentOffline if this is a reused float; reset to 0 for a fresh one
    floatSpentOffline: data.reused ? (currentMeta.floatSpentOffline || 0) : 0,
    floatNextSeq: data.reused ? (currentMeta.floatNextSeq ?? data.startingSeq) : data.startingSeq
  });

  return data;
}
