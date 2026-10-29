/**
 * Local Ledger & Offline Verification — Module 4
 *
 * IndexedDB-backed local transaction store.
 * Balance is derived by summing transactions, never stored as a mutable number.
 */

import { openDB } from '../identity/keyStore';
import { verifyTransaction } from '../transaction/builder';

// Transaction status values
export const TXN_STATUS = {
  PENDING_SCAN: 'pending_scan',       // QR generated, not yet scanned by receiver
  PENDING_SYNC: 'pending_sync',       // Scanned by receiver, waiting for server sync
  CONFIRMED: 'confirmed',
  REJECTED_DOUBLE_SPEND: 'rejected_double_spend',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled'             // User cancelled before receiver scanned
};

/**
 * Record a transaction as sent (outgoing) with status PENDING_SCAN.
 * Called when the sender generates the QR code.
 *
 * STATUS = PENDING_SCAN means the QR has been generated but NOT yet scanned.
 * The balance does NOT change at this point — it only changes once the
 * receiver scans the QR (status moves to PENDING_SYNC via confirmSentTransaction).
 *
 * This prevents the balance from dropping the moment a QR is generated,
 * before any money has actually changed hands.
 *
 * @param {object} signedTxn - the full signed payload
 */
export async function recordSentTransaction(signedTxn) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['localTransactions', 'usedNonces'], 'readwrite');
    const txStore = tx.objectStore('localTransactions');
    const nonceStore = tx.objectStore('usedNonces');

    const entry = {
      txnId: signedTxn.txnId,
      direction: 'sent',
      counterpartyVpa: signedTxn.receiverVpa || '(pending scan)',
      amount: signedTxn.amount,
      timestamp: signedTxn.timestamp,
      // PENDING_SCAN: does NOT affect balance yet — receiver hasn't scanned yet
      status: TXN_STATUS.PENDING_SCAN,
      rawPayload: signedTxn
    };

    const putReq = txStore.put(entry);
    const nonceReq = nonceStore.put({ nonce: signedTxn.nonce, seenAt: Date.now() });

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      const err = tx.error;
      reject(new Error(`Failed to store transaction: ${err?.message || 'unknown error'}`));
    };
  });
}

/**
 * Confirm a sent transaction after the receiver has scanned the QR.
 * Moves status from PENDING_SCAN → PENDING_SYNC, sets the receiver's VPA,
 * and updates rawPayload.receiverVpa so sync can send it to the server.
 *
 * @param {string} txnId
 * @param {string} receiverVpa - actual receiver VPA from the ack
 */
export async function confirmSentTransaction(txnId, receiverVpa) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('localTransactions', 'readwrite');
    const store = tx.objectStore('localTransactions');
    const getReq = store.get(txnId);

    getReq.onsuccess = () => {
      const entry = getReq.result;
      if (!entry) { resolve(); return; }

      entry.status = TXN_STATUS.PENDING_SYNC;

      // Update counterpartyVpa from "(pending scan)" to the real receiver VPA
      if (receiverVpa) {
        entry.counterpartyVpa = receiverVpa;
        // Critical: update rawPayload.receiverVpa so the sync service
        // sends a complete payload to the server (empty receiverVpa is filtered out)
        if (entry.rawPayload) {
          entry.rawPayload = { ...entry.rawPayload, receiverVpa };
        }
      }

      const putReq = store.put(entry);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Cancel a pending_scan transaction (user backed out before receiver scanned).
 * Sets status to CANCELLED so it does not affect balance.
 *
 * @param {string} txnId
 */
export async function cancelSentTransaction(txnId) {
  return updateTransactionStatus(txnId, TXN_STATUS.CANCELLED);
}

/**
 * Process a scanned QR payload on the receiver side.
 * Performs offline verification: signature check, nonce replay check, timestamp check.
 *
 * @param {object} scannedPayload - decoded QR payload with receiverVpa set
 * @returns {{ success: boolean, error?: string }}
 */
export async function receiveScannedTransaction(scannedPayload) {
  const db = await openDB();

  // Step 1: Verify signature.
  // The sender signed with receiverVpa='' (empty) — that is what we verify against.
  // The scannedPayload may already have receiverVpa set to the current user's VPA
  // (set by ReceivePage before calling this function), so we pass the original
  // signed version (receiverVpa='') to verifyTransaction.
  const payloadForVerify = { ...scannedPayload, receiverVpa: '' };
  const { valid, error: sigError } = verifyTransaction(payloadForVerify);
  if (!valid) {
    return { success: false, error: sigError || 'Invalid signature' };
  }

  // Step 2: Check nonce replay
  const nonceExists = await new Promise((resolve, reject) => {
    const tx = db.transaction('usedNonces', 'readonly');
    const store = tx.objectStore('usedNonces');
    const req = store.get(scannedPayload.nonce);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => reject(req.error);
  });

  if (nonceExists) {
    return { success: false, error: 'This QR code has already been used (replay attempt)' };
  }

  // Step 3: Write to localTransactions and mark nonce as used (atomic-ish)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['localTransactions', 'usedNonces'], 'readwrite');
    const txStore = tx.objectStore('localTransactions');
    const nonceStore = tx.objectStore('usedNonces');

    const entry = {
      txnId: scannedPayload.txnId,
      direction: 'received',
      counterpartyVpa: scannedPayload.senderVpa,
      amount: scannedPayload.amount,
      timestamp: scannedPayload.timestamp,
      status: TXN_STATUS.PENDING_SYNC,
      rawPayload: scannedPayload
    };

    const putReq = txStore.put(entry);

    // The unique keyPath on usedNonces rejects duplicates at the DB level —
    // this is the backstop against a race condition (two scans in quick succession)
    const nonceReq = nonceStore.add({ nonce: scannedPayload.nonce, seenAt: Date.now() });

    tx.oncomplete = () => resolve({ success: true });
    tx.onerror = () => {
      const err = tx.error;
      if (err?.name === 'ConstraintError') {
        resolve({ success: false, error: 'This QR code has already been used' });
      } else {
        reject(new Error(`Failed to store received transaction: ${err?.message || 'storage error'}`));
      }
    };
  });
}

/**
 * Get all local transactions, sorted by timestamp descending.
 */
export async function getAllLocalTransactions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('localTransactions', 'readonly');
    const store = tx.objectStore('localTransactions');
    const req = store.getAll();
    req.onsuccess = () => {
      const sorted = (req.result || []).sort((a, b) => b.timestamp - a.timestamp);
      resolve(sorted);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get all pending_sync transactions (to be sent to the server on next sync).
 * NOTE: PENDING_SCAN transactions are intentionally excluded — they haven't
 * been scanned by a receiver yet and cannot be validated by the Switch
 * (receiverVpa is still empty).
 */
export async function getPendingSyncTransactions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('localTransactions', 'readonly');
    const store = tx.objectStore('localTransactions');
    const index = store.index('status');
    const req = index.getAll(TXN_STATUS.PENDING_SYNC);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Update a transaction's status (called after sync response).
 *
 * @param {string} txnId
 * @param {string} status - one of TXN_STATUS values
 * @param {string} [message] - optional rejection reason
 */
export async function updateTransactionStatus(txnId, status, message) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('localTransactions', 'readwrite');
    const store = tx.objectStore('localTransactions');
    const getReq = store.get(txnId);

    getReq.onsuccess = () => {
      const entry = getReq.result;
      if (!entry) { resolve(); return; }

      entry.status = status;
      if (message) entry.rejectionReason = message;

      const putReq = store.put(entry);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Compute displayed balance from local transactions + server-synced base balance.
 *
 * Balance = lastSyncedBalance + SUM(received pending/confirmed) - SUM(sent pending/confirmed)
 *
 * Balance is NEVER stored as a mutable number — always derived from history.
 * This keeps local state auditable and makes server reconciliation straightforward.
 *
 * @returns {{ balance: number, pendingCount: number }}
 */
export async function computeLocalBalance() {
  const db = await openDB();

  const [transactions, meta] = await Promise.all([
    getAllLocalTransactions(),
    new Promise((resolve, reject) => {
      const tx = db.transaction('walletMeta', 'readonly');
      const store = tx.objectStore('walletMeta');
      const req = store.get('meta');
      req.onsuccess = () => resolve(req.result || { lastSyncedBalance: 0 });
      req.onerror = () => reject(req.error);
    })
  ]);

  let localDelta = 0;
  let pendingCount = 0;

  for (const txn of transactions) {
    // Only count pending_sync and confirmed — skip rejected, cancelled, and pending_scan.
    // PENDING_SCAN means QR was generated but receiver hasn't scanned yet —
    // the money has NOT left the sender's wallet until the QR is scanned.
    if (
      txn.status === TXN_STATUS.REJECTED ||
      txn.status === TXN_STATUS.REJECTED_DOUBLE_SPEND ||
      txn.status === TXN_STATUS.CANCELLED ||
      txn.status === TXN_STATUS.PENDING_SCAN
    ) {
      continue;
    }
    if (txn.direction === 'received') {
      localDelta += txn.amount;
    } else if (txn.direction === 'sent') {
      localDelta -= txn.amount;
    }
    if (txn.status === TXN_STATUS.PENDING_SYNC) pendingCount++;
  }

  return {
    balance: meta.lastSyncedBalance + localDelta,
    pendingCount
  };
}

/**
 * Update the last synced balance and float state in walletMeta.
 */
export async function updateWalletMeta(updates) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('walletMeta', 'readwrite');
    const store = tx.objectStore('walletMeta');
    const getReq = store.get('meta');

    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      const merged = { ...existing, ...updates };
      const putReq = store.put(merged, 'meta');
      putReq.onsuccess = () => resolve(merged);
      putReq.onerror = () => reject(putReq.error);
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Get the wallet metadata (lastSyncedBalance, float info, etc.)
 */
export async function getWalletMeta() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('walletMeta', 'readonly');
    const store = tx.objectStore('walletMeta');
    const req = store.get('meta');
    req.onsuccess = () => resolve(req.result || { lastSyncedBalance: 0 });
    req.onerror = () => reject(req.error);
  });
}
