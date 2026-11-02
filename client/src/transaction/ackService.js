/**
 * Acknowledgement Service
 *
 * Channels (tried in order, all in parallel):
 * 1. BroadcastChannel — same device, cross-tab, instant, works offline
 * 2. localStorage     — same browser, cross-tab, instant, works offline
 * 3. IndexedDB        — persistent across reloads, works offline
 * 4. Server /api/ack  — cross-device, requires internet
 *
 * The sender polls all 4 channels every 2.5s.
 * As long as sender & receiver share ANY channel, the ack will arrive.
 */

import { openDB } from '../identity/keyStore';

const ACK_PREFIX = 'ack:';
const API_BASE = import.meta.env.VITE_API_URL || '/api';

// BroadcastChannel — works across tabs on same device, fully offline
let bc = null;
try { bc = new BroadcastChannel('offlinepay_ack'); } catch {}

// In-memory cache of received acks (for instant same-session reads)
const memAcks = new Map();

// Listen for acks from other tabs via BroadcastChannel
if (bc) {
  bc.onmessage = (event) => {
    if (event.data?.type === 'ack' && event.data.ack?.txnId) {
      memAcks.set(event.data.ack.txnId, event.data.ack);
      // Also write to localStorage for persistence
      try {
        localStorage.setItem(`${ACK_PREFIX}${event.data.ack.txnId}`, JSON.stringify(event.data.ack));
      } catch {}
    }
  };
}

/** Write ack to IndexedDB */
async function writeAckToIDB(ack) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('walletMeta', 'readwrite');
      const store = tx.objectStore('walletMeta');
      const req = store.put(ack, `${ACK_PREFIX}${ack.txnId}`);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {}
}

/** Read ack from IndexedDB */
async function readAckFromIDB(txnId) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('walletMeta', 'readonly');
      const store = tx.objectStore('walletMeta');
      const req = store.get(`${ACK_PREFIX}${txnId}`);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

/**
 * Receiver calls this after successfully verifying and recording a payment.
 * Broadcasts ack across all available channels.
 */
export async function writeAck(txnId, receiverVpa, status = 'accepted', reason = '', token = '') {
  const ack = { txnId, receiverVpa, acceptedAt: Date.now(), status, reason };

  // In-memory (instant for same JS context)
  memAcks.set(txnId, ack);

  // Channel 1: BroadcastChannel (cross-tab, same device, offline)
  try { bc?.postMessage({ type: 'ack', ack }); } catch {}

  // Channel 2: localStorage (cross-tab, same browser, offline)
  try { localStorage.setItem(`${ACK_PREFIX}${txnId}`, JSON.stringify(ack)); } catch {}

  // Channel 3: IndexedDB (persistent, survives reload, offline)
  await writeAckToIDB(ack);

  // Channel 4: Server (cross-device, needs internet — non-fatal if offline)
  try {
    await fetch(`${API_BASE}/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(ack)
    });
  } catch {
    // Offline — other channels handle same-device delivery
  }
}

/**
 * Sender polls this to check if an ack has arrived.
 * Checks all channels: memory → localStorage → IndexedDB → server.
 */
export async function checkAck(txnId, token = '') {
  // Channel 1: in-memory (instant)
  if (memAcks.has(txnId)) return memAcks.get(txnId);

  // Channel 2: localStorage
  try {
    const raw = localStorage.getItem(`${ACK_PREFIX}${txnId}`);
    if (raw) {
      const ack = JSON.parse(raw);
      memAcks.set(txnId, ack);
      return ack;
    }
  } catch {}

  // Channel 3: IndexedDB (works offline, survives reload)
  const idbAck = await readAckFromIDB(txnId);
  if (idbAck) {
    memAcks.set(txnId, idbAck);
    return idbAck;
  }

  // Channel 4: Server (cross-device, needs internet)
  try {
    const res = await fetch(`${API_BASE}/ack/${encodeURIComponent(txnId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(3000) // 3s timeout — don't block offline detection
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ack) {
        memAcks.set(txnId, data.ack);
        localStorage.setItem(`${ACK_PREFIX}${txnId}`, JSON.stringify(data.ack));
        await writeAckToIDB(data.ack);
        return data.ack;
      }
    }
  } catch {}

  return null;
}

/**
 * Clean up ack from all local stores once sender has processed it.
 */
export async function clearAck(txnId) {
  memAcks.delete(txnId);
  try { localStorage.removeItem(`${ACK_PREFIX}${txnId}`); } catch {}
  try {
    const db = await openDB();
    const tx = db.transaction('walletMeta', 'readwrite');
    tx.objectStore('walletMeta').delete(`${ACK_PREFIX}${txnId}`);
  } catch {}
}
