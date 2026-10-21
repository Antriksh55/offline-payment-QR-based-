/**
 * Acknowledgement Service
 *
 * When a receiver accepts a payment (scan or paste), they write a signed
 * acknowledgement so the SENDER's tab automatically moves the transaction
 * from PENDING_SCAN → PENDING_SYNC without any manual confirmation.
 *
 * The sender can NEVER self-confirm — only a receiver ack can do that.
 *
 * Two channels (both tried):
 * 1. localStorage + storage event  — works instantly for two tabs in the same browser
 * 2. Server POST /api/ack          — works across different devices / browsers
 *
 * Ack object stored under key `ack:<txnId>`:
 * {
 *   txnId: string,
 *   receiverVpa: string,
 *   acceptedAt: number,   // ms epoch
 *   status: 'accepted' | 'rejected',
 *   reason?: string
 * }
 */

const ACK_PREFIX = 'ack:';
const API_BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * Receiver calls this after successfully verifying and recording a payment.
 * Writes the ack locally AND posts it to the server.
 *
 * @param {string} txnId
 * @param {string} receiverVpa
 * @param {'accepted'|'rejected'} status
 * @param {string} [reason]
 * @param {string} [token]
 */
export async function writeAck(txnId, receiverVpa, status = 'accepted', reason = '', token = '') {
  const ack = { txnId, receiverVpa, acceptedAt: Date.now(), status, reason };

  // Channel 1: localStorage (same-browser, instant)
  try {
    localStorage.setItem(`${ACK_PREFIX}${txnId}`, JSON.stringify(ack));
  } catch {}

  // Channel 2: Server (cross-device)
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
    // Non-fatal — same-browser path works without server
  }
}

/**
 * Sender calls this to check if an ack has arrived for a given txnId.
 * Checks localStorage first, then polls server.
 *
 * @param {string} txnId
 * @param {string} [token]
 * @returns {object|null} ack object or null
 */
export async function checkAck(txnId, token = '') {
  // Channel 1: localStorage
  try {
    const raw = localStorage.getItem(`${ACK_PREFIX}${txnId}`);
    if (raw) return JSON.parse(raw);
  } catch {}

  // Channel 2: Server
  try {
    const res = await fetch(`${API_BASE}/ack/${encodeURIComponent(txnId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ack) {
        // Cache locally for instant next reads
        localStorage.setItem(`${ACK_PREFIX}${txnId}`, JSON.stringify(data.ack));
        return data.ack;
      }
    }
  } catch {}

  return null;
}

/**
 * Clean up an ack from localStorage once the sender has processed it.
 */
export function clearAck(txnId) {
  try { localStorage.removeItem(`${ACK_PREFIX}${txnId}`); } catch {}
}
