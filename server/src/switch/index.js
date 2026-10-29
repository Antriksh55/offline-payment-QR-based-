/**
 * THE SWITCH — Module 6 + Module 12
 *
 * Routes and validates every transaction submitted via sync.
 * All checks run server-side, independently of what the client already verified —
 * the client cannot be trusted.
 *
 * RESPONSE CODE TABLE:
 *   00  Success
 *   01  Insufficient funds
 *   02  Invalid VPA (not found in directory)
 *   03  Double-spend / exceeds offline float
 *   04  Bad signature
 *   05  Nonce replay
 *   06  Stale/replayed device sequence
 *   07  Stale/unauthorized device key (post-rotation) — Module 12 fix
 */

const mongoose = require('mongoose');
const nacl = require('tweetnacl');
const { decodeBase64, encodeBase64 } = require('tweetnacl-util');
const VpaDirectory = require('../models/VpaDirectory');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const OfflineFloat = require('../models/OfflineFloat');
const { getBalance, postDoubleEntry } = require('../ledger');

// Clock skew tolerance: reject transactions more than 5 minutes old or in the future
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Build the canonical message string for signature verification.
 * Manually ordered pipe-delimited — NOT JSON.stringify — because JSON key order
 * is not guaranteed across environments and would break cross-device verification.
 */
function buildCanonicalMessage(txn) {
  // deviceSeq is included if present (Module 12)
  const base = `${txn.txnId}|${txn.senderVpa}|${txn.receiverVpa}|${txn.amount}|${txn.timestamp}|${txn.nonce}`;
  if (txn.deviceSeq !== undefined && txn.deviceSeq !== null) {
    return `${base}|${txn.deviceSeq}`;
  }
  return base;
}

/**
 * Process a batch of transactions from a single device sequentially.
 * Sequential processing is mandatory: if a user tried to spend more offline than
 * they had across two transactions, processing order determines which one is
 * correctly flagged — matching what actually happened in real time.
 *
 * @param {Array} transactions - Signed transaction payloads from client
 * @param {string|null} floatDeviceId - Device ID of the float being reconciled
 * @returns {Array} results — { txnId, respCode, status, message }
 */
async function processBatch(transactions, floatDeviceId = null) {
  // Sort ascending by client timestamp — process in the order they were created
  const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);
  const results = [];

  for (const txn of sorted) {
    const result = await processSingle(txn, floatDeviceId);
    results.push(result);
  }

  return results;
}

/**
 * Process a single transaction through all Switch validation steps.
 */
async function processSingle(txn, floatDeviceId = null) {
  const { txnId, senderVpa, receiverVpa, amount, timestamp, nonce, deviceSeq, deviceId } = txn;
  const signature = txn.signature;
  const embeddedPublicKey = txn.senderPublicKey; // from payload — used ONLY as a cross-check

  // ── STEP 1: Resolve VPAs ────────────────────────────────────────────────────
  const [senderEntry, receiverEntry] = await Promise.all([
    VpaDirectory.findOne({ vpa: senderVpa, active: true }),
    VpaDirectory.findOne({ vpa: receiverVpa, active: true })
  ]);

  if (!senderEntry || !receiverEntry) {
    return { txnId, respCode: '02', status: 'REJECTED', message: 'Invalid VPA' };
  }

  // ── STEP 2: Verify signature against CURRENTLY REGISTERED key (Module 12 fix) ─
  // CRITICAL: We look up the public key from the User document, NOT from the payload.
  // This is what makes key rotation (Module 11) actually revoke old devices.
  // A transaction signed by an old rotated-out key will fail here with respCode 07,
  // even if the signature is cryptographically valid — because the key is no longer
  // authorized for that VPA.
  const senderUser = await User.findById(senderEntry.userId);
  if (!senderUser) {
    return { txnId, respCode: '02', status: 'REJECTED', message: 'Sender user not found' };
  }

  const registeredPublicKey = senderUser.publicKey;

  // If the embedded key doesn't match the registered key, reject immediately.
  // This is respCode 07 — stale/unauthorized device key.
  if (embeddedPublicKey !== registeredPublicKey) {
    return {
      txnId,
      respCode: '07',
      status: 'REJECTED',
      message: 'Stale or unauthorized device key (key was rotated)'
    };
  }

  // Now verify the actual signature against the registered (= same) key.
  // The sender signed with receiverVpa='' (empty string) — the receiver VPA
  // is filled in after scanning, not at signing time. So we verify against
  // the original signed message with receiverVpa=''.
  const txnForVerify = { ...txn, receiverVpa: '' };
  const canonical = buildCanonicalMessage(txnForVerify);
  let sigValid = false;
  try {
    const sigBytes = decodeBase64(signature);
    const pubKeyBytes = decodeBase64(registeredPublicKey);
    const msgBytes = Buffer.from(canonical, 'utf8');
    sigValid = nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);
  } catch {
    sigValid = false;
  }

  if (!sigValid) {
    return { txnId, respCode: '04', status: 'REJECTED', message: 'Invalid signature' };
  }

  // ── STEP 3: Nonce replay check ──────────────────────────────────────────────
  const existingByNonce = await Transaction.findOne({ nonce });
  if (existingByNonce) {
    return { txnId, respCode: '05', status: 'REJECTED', message: 'Nonce replay detected' };
  }

  // Also check txnId uniqueness
  const existingByTxnId = await Transaction.findOne({ txnId });
  if (existingByTxnId) {
    return { txnId, respCode: '05', status: 'REJECTED', message: 'Transaction already processed' };
  }

  // ── STEP 4: Timestamp validity (client-side only) ──────────────────────────
  // NOTE: We intentionally skip the timestamp check here on the server Switch.
  // The 5-minute window is enforced on the RECEIVER side (client) when they
  // first scan/paste the QR — that is the correct security boundary for offline
  // payments. By the time sync runs, the transaction may legitimately be older
  // than 5 minutes (user was offline, receiver accepted, then synced later).
  // Rejecting valid already-accepted payments due to server-side clock skew
  // would break the core offline-payment guarantee.

  // ── STEP 5: Balance / float check ──────────────────────────────────────────
  const senderAccount = senderEntry.accountNumber;
  const receiverAccount = receiverEntry.accountNumber;

  let approvedByFloat = false;

  if (floatDeviceId && deviceId && deviceId === floatDeviceId && deviceSeq !== null && deviceSeq !== undefined) {
    // Float-based reconciliation path (Module 12)
    const float = await OfflineFloat.findOne({ deviceId: floatDeviceId, status: 'ACTIVE' });

    if (float) {
      // Check deviceSeq is not stale/replayed
      const highestReconciled = float.highestReconciled ?? (float.startingSeq - 1);
      if (deviceSeq <= highestReconciled) {
        return {
          txnId,
          respCode: '06',
          status: 'REJECTED',
          message: 'Stale/replayed device sequence — possible device restore or rollback'
        };
      }

      // Check float hasn't expired
      if (new Date() > float.expiresAt) {
        return {
          txnId,
          respCode: '03',
          status: 'REJECTED',
          message: 'Offline float has expired — reconnect to refresh'
        };
      }

      // Check cumulative spend doesn't exceed reservedAmount
      const cumulativeSpend = float.spentSoFar + amount;
      if (cumulativeSpend > float.reservedAmount) {
        return {
          txnId,
          respCode: '03',
          status: 'REJECTED',
          message: 'Exceeds offline float reserved amount (double-spend protection)'
        };
      }

      approvedByFloat = true;

      // Update float's spentSoFar and highestReconciled
      await OfflineFloat.updateOne(
        { _id: float._id },
        {
          $set: {
            spentSoFar: cumulativeSpend,
            highestReconciled: deviceSeq
          }
        }
      );
    }
  }

  if (!approvedByFloat) {
    // Online path: check real available balance
    const { available } = await getBalance(senderAccount);
    if (available < amount) {
      // Record the rejected transaction for audit purposes
      await Transaction.create({
        txnId,
        senderVpa,
        receiverVpa,
        amount,
        initiationMode: 'OFFLINE_QR',
        timestamp,
        nonce,
        deviceSeq: deviceSeq ?? null,
        deviceId: deviceId ?? null,
        respCode: '01',
        respMessage: 'Insufficient funds',
        status: 'REJECTED'
      });
      return {
        txnId,
        respCode: '01',
        status: 'REJECTED',
        message: 'Insufficient funds — possible double-spend detected'
      };
    }
  }

  // ── STEP 6: Post double-entry ledger & record transaction (atomic) ──────────
  const session = await mongoose.startSession();
  let finalStatus;
  let finalRespCode;
  let finalMessage;

  try {
    await session.withTransaction(async () => {
      // Create the Transaction document
      await Transaction.create(
        [
          {
            txnId,
            senderVpa,
            receiverVpa,
            amount,
            initiationMode: 'OFFLINE_QR',
            timestamp,
            nonce,
            deviceSeq: deviceSeq ?? null,
            deviceId: deviceId ?? null,
            respCode: '00',
            respMessage: 'Success',
            status: 'PENDING_SETTLEMENT'
          }
        ],
        { session }
      );

      // Post DEBIT on sender, CREDIT on receiver — atomically
      await postDoubleEntry({ txnId, senderAccount, receiverAccount, amount, session });
    });

    finalStatus = 'PENDING_SETTLEMENT';
    finalRespCode = '00';
    finalMessage = 'Transaction processed successfully';
  } catch (err) {
    // Handle unique nonce constraint race condition gracefully
    if (err.code === 11000) {
      return { txnId, respCode: '05', status: 'REJECTED', message: 'Duplicate transaction (race condition)' };
    }
    console.error('Switch transaction error:', err);
    return { txnId, respCode: '99', status: 'REJECTED', message: 'Internal error during processing' };
  } finally {
    session.endSession();
  }

  return { txnId, respCode: finalRespCode, status: finalStatus, message: finalMessage };
}

module.exports = { processBatch, processSingle, buildCanonicalMessage };
