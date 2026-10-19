/**
 * Transaction Construction & Signing — Module 2
 *
 * Builds and signs offline payment transactions using Ed25519.
 * All amounts are in paise (smallest currency unit) — never rupees.
 * Floating-point currency is explicitly rejected.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

// Clock skew tolerance: QR codes are valid for ±5 minutes
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Build the canonical message string for signing/verification.
 * Pipe-delimited, manually ordered — NOT JSON.stringify — because JSON key ordering
 * is not guaranteed across JS environments and would break cross-device verification.
 *
 * Includes deviceSeq if present (Module 12 offline float).
 */
export function buildCanonicalMessage(txn) {
  const base = `${txn.txnId}|${txn.senderVpa}|${txn.receiverVpa}|${txn.amount}|${txn.timestamp}|${txn.nonce}`;
  if (txn.deviceSeq !== undefined && txn.deviceSeq !== null) {
    return `${base}|${txn.deviceSeq}`;
  }
  return base;
}

/**
 * Validate amount before signing.
 * Returns null if valid, or an error string if not.
 *
 * @param {number|string} amount - paise
 * @param {number} localBalance - sender's locally known balance in paise
 * @returns {string|null}
 */
export function validateAmount(amount, localBalance) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return 'Amount must be a number';
  if (!Number.isInteger(parsed)) return 'Amount must be a whole number (paise, not rupees)';
  if (parsed <= 0) return 'Amount must be greater than zero';
  if (parsed > localBalance) {
    // Return a warning string (not blocking — server will catch double-spend)
    return `__WARN__:Amount exceeds your current balance (₹${(localBalance / 100).toFixed(2)}). The transaction will proceed but may be rejected during sync.`;
  }
  return null;
}

/**
 * Build and sign a transaction.
 *
 * @param {object} params
 * @param {string} params.senderVpa
 * @param {number} params.amount - in paise
 * @param {string} params.privateKeyB64 - base64 private key
 * @param {string} params.publicKeyB64 - base64 public key
 * @param {string} [params.deviceId]
 * @param {number} [params.deviceSeq] - for offline float (Module 12)
 * @returns {object} signed transaction payload
 */
export function buildSignedTransaction({ senderVpa, amount, privateKeyB64, publicKeyB64, deviceId, deviceSeq }) {
  // txnId and nonce use crypto.randomUUID() — never Math.random()
  const txnId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const timestamp = Date.now();

  // receiverVpa is intentionally left empty — the receiver fills it in after scanning
  const txn = {
    txnId,
    senderVpa,
    receiverVpa: '',    // filled by receiver on scan
    amount,
    timestamp,
    nonce,
    ...(deviceId !== undefined && { deviceId }),
    ...(deviceSeq !== undefined && deviceSeq !== null && { deviceSeq })
  };

  const canonical = buildCanonicalMessage(txn);
  const msgBytes = new TextEncoder().encode(canonical);
  const privateKeyBytes = decodeBase64(privateKeyB64);

  // Sign using Ed25519
  const sigBytes = nacl.sign.detached(msgBytes, privateKeyBytes);

  return {
    ...txn,
    signature: encodeBase64(sigBytes),
    senderPublicKey: publicKeyB64
  };
}

/**
 * Verify a transaction's signature.
 * Used on the receiver side (Module 4) before accepting a scanned QR.
 *
 * @param {object} txn - the full signed payload
 * @returns {{ valid: boolean, error?: string }}
 */
export function verifyTransaction(txn) {
  try {
    const { signature, senderPublicKey, ...rest } = txn;

    if (!signature || !senderPublicKey) {
      return { valid: false, error: 'Missing signature or public key' };
    }

    // Check timestamp validity window (±5 minutes)
    const now = Date.now();
    if (Math.abs(now - txn.timestamp) > TIMESTAMP_TOLERANCE_MS) {
      return { valid: false, error: 'Transaction has expired or timestamp is too far in the future' };
    }

    const canonical = buildCanonicalMessage(txn);
    const msgBytes = new TextEncoder().encode(canonical);
    const sigBytes = decodeBase64(signature);
    const pubKeyBytes = decodeBase64(senderPublicKey);

    const valid = nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);
    return { valid, error: valid ? undefined : 'Signature verification failed' };
  } catch (err) {
    return { valid: false, error: `Verification error: ${err.message}` };
  }
}
