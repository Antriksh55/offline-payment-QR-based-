/**
 * Offline Float (Escrow) Service — Module 12
 *
 * Issues a bounded offline spending allowance by immediately posting a HOLD
 * ledger entry for the reserved amount. This is the mechanism that makes
 * offline damage bounded — the funds are removed from available balance
 * *before* the device goes offline.
 *
 * MAX_OFFLINE_LIMIT: the maximum offline float that can be issued.
 * Set to 200000 paise (₹2000) for demo purposes.
 */

const { v4: uuidv4 } = require('uuid');
const OfflineFloat = require('../models/OfflineFloat');
const VpaDirectory = require('../models/VpaDirectory');
const { getBalance, postHold, releaseHold } = require('../ledger');

const MAX_OFFLINE_LIMIT = 200000; // paise — cumulative cap, NOT a per-transaction cap
const FLOAT_TTL_HOURS = 24;

/**
 * Request or return an existing offline float for the given account.
 *
 * @param {string} vpa
 * @param {string} deviceId
 * @returns {{ reservedAmount, expiresAt, startingSeq, reused: boolean }}
 */
async function requestFloat(vpa, deviceId) {
  const vpaEntry = await VpaDirectory.findOne({ vpa, active: true });
  if (!vpaEntry) throw new Error('VPA not found');

  const accountNumber = vpaEntry.accountNumber;

  // Check for existing active float on this account
  const existing = await OfflineFloat.findOne({ accountNumber, status: 'ACTIVE' });
  if (existing && new Date() < existing.expiresAt) {
    // Return the existing float rather than issuing a duplicate
    return {
      reservedAmount: existing.reservedAmount,
      expiresAt: existing.expiresAt,
      startingSeq: existing.startingSeq,
      reused: true
    };
  }

  // Get real current available balance
  const { available } = await getBalance(accountNumber);
  const reservedAmount = Math.min(available, MAX_OFFLINE_LIMIT);

  if (reservedAmount <= 0) {
    throw new Error('Insufficient balance to issue an offline float');
  }

  const holdTxnId = `HOLD-${uuidv4()}`;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + FLOAT_TTL_HOURS * 60 * 60 * 1000);

  // The startingSeq is 1 if no previous float for this device,
  // or last highestReconciled + 1 so sequences don't collide across float periods
  const lastFloat = await OfflineFloat.findOne({ deviceId }).sort({ issuedAt: -1 });
  const startingSeq = lastFloat && lastFloat.highestReconciled !== null
    ? lastFloat.highestReconciled + 1
    : 1;

  // CRITICAL: Post the HOLD ledger entry IMMEDIATELY.
  // This removes the reserved amount from available balance server-side
  // regardless of what the client does — this is the real protection.
  // (Skipping this step and reserving only in application memory provides no real security.)
  await postHold({ txnId: holdTxnId, accountNumber, amount: reservedAmount });

  const float = await OfflineFloat.create({
    accountNumber,
    reservedAmount,
    spentSoFar: 0,
    issuedAt,
    expiresAt,
    deviceId,
    startingSeq,
    highestReconciled: null,
    holdTxnId,
    status: 'ACTIVE'
  });

  return {
    reservedAmount: float.reservedAmount,
    expiresAt: float.expiresAt,
    startingSeq: float.startingSeq,
    reused: false
  };
}

/**
 * Finalize a float after all its transactions are reconciled.
 * Converts the HOLD into real DEBIT/CREDITs and releases unused portion.
 *
 * @param {string} deviceId
 */
async function reconcileFloat(deviceId) {
  const float = await OfflineFloat.findOne({ deviceId, status: 'ACTIVE' });
  if (!float) return;

  const unused = float.reservedAmount - float.spentSoFar;

  // Release any unspent portion of the hold back to available balance
  if (unused > 0) {
    await releaseHold({
      txnId: `HOLD_RELEASE-${float.holdTxnId}`,
      accountNumber: float.accountNumber,
      amount: unused
    });
  }

  await OfflineFloat.updateOne({ _id: float._id }, { status: 'RECONCILED' });
}

/**
 * Scheduled expiry job: mark overdue ACTIVE floats as EXPIRED and release their holds.
 * Should be called periodically (e.g. every 5 minutes via node-cron).
 */
async function expireStaleFloats() {
  const stale = await OfflineFloat.find({
    status: 'ACTIVE',
    expiresAt: { $lt: new Date() }
  });

  for (const float of stale) {
    const unused = float.reservedAmount - float.spentSoFar;
    if (unused > 0) {
      await releaseHold({
        txnId: `HOLD_RELEASE-EXPIRED-${float.holdTxnId}`,
        accountNumber: float.accountNumber,
        amount: unused
      });
    }
    await OfflineFloat.updateOne({ _id: float._id }, { status: 'EXPIRED' });
    console.log(`[Float] Expired float for device ${float.deviceId}, released ${unused} paise hold`);
  }

  return stale.length;
}

module.exports = { requestFloat, reconcileFloat, expireStaleFloats, MAX_OFFLINE_LIMIT };
