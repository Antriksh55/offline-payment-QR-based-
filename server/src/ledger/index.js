const mongoose = require('mongoose');
const LedgerEntry = require('../models/LedgerEntry');
const Transaction = require('../models/Transaction');

/**
 * Compute account balance from ledger entries.
 * available = SUM(CREDIT) - SUM(DEBIT) - SUM(active HOLD) + SUM(HOLD_RELEASE)
 *
 * NEVER read a cached balance field — this is the single source of truth.
 *
 * @param {string} accountNumber
 * @returns {{ balance: number, available: number }}
 */
async function getBalance(accountNumber) {
  const result = await LedgerEntry.aggregate([
    { $match: { accountNumber } },
    {
      $group: {
        _id: null,
        creditSum: {
          $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] }
        },
        debitSum: {
          $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] }
        },
        holdSum: {
          $sum: { $cond: [{ $eq: ['$type', 'HOLD'] }, '$amount', 0] }
        },
        holdReleaseSum: {
          $sum: { $cond: [{ $eq: ['$type', 'HOLD_RELEASE'] }, '$amount', 0] }
        }
      }
    }
  ]);

  if (result.length === 0) {
    return { balance: 0, available: 0 };
  }

  const { creditSum, debitSum, holdSum, holdReleaseSum } = result[0];
  const balance = creditSum - debitSum;
  const available = balance - (holdSum - holdReleaseSum);
  return { balance, available };
}

/**
 * Post a double-entry ledger pair atomically within an existing Mongoose session.
 * Posts one DEBIT on senderAccount and one CREDIT on receiverAccount for the same amount.
 * Must be called inside session.withTransaction() — caller provides the session.
 *
 * @param {object} params
 * @param {string} params.txnId
 * @param {string} params.senderAccount
 * @param {string} params.receiverAccount
 * @param {number} params.amount
 * @param {mongoose.ClientSession} params.session
 */
async function postDoubleEntry({ txnId, senderAccount, receiverAccount, amount, session }) {
  await LedgerEntry.insertMany(
    [
      {
        txnId,
        accountNumber: senderAccount,
        type: 'DEBIT',
        amount,
        postedAt: new Date()
      },
      {
        txnId,
        accountNumber: receiverAccount,
        type: 'CREDIT',
        amount,
        postedAt: new Date()
      }
    ],
    { session }
  );
}

/**
 * Post a HOLD ledger entry for offline float issuance.
 * The hold amount is subtracted from available balance but is NOT yet a real DEBIT.
 *
 * @param {object} params
 * @param {string} params.txnId  - A synthetic txnId for this hold entry
 * @param {string} params.accountNumber
 * @param {number} params.amount
 * @param {mongoose.ClientSession} [params.session]
 */
async function postHold({ txnId, accountNumber, amount, session }) {
  const opts = session ? { session } : {};
  await LedgerEntry.create(
    [{ txnId, accountNumber, type: 'HOLD', amount, postedAt: new Date() }],
    opts
  );
}

/**
 * Release a hold (partially or fully) by posting a HOLD_RELEASE entry.
 *
 * @param {object} params
 * @param {string} params.txnId
 * @param {string} params.accountNumber
 * @param {number} params.amount
 * @param {mongoose.ClientSession} [params.session]
 */
async function releaseHold({ txnId, accountNumber, amount, session }) {
  const opts = session ? { session } : {};
  await LedgerEntry.create(
    [{ txnId, accountNumber, type: 'HOLD_RELEASE', amount, postedAt: new Date() }],
    opts
  );
}

/**
 * Invariant check: SUM(all DEBITs) must equal SUM(all CREDITs) across the whole ledger.
 * This is the most important correctness check in the system.
 * HOLDs and HOLD_RELEASEs do not affect this invariant — only real DEBITs and CREDITs count.
 *
 * @returns {{ debitTotal: number, creditTotal: number, balanced: boolean }}
 */
async function checkLedgerInvariant() {
  const result = await LedgerEntry.aggregate([
    { $match: { type: { $in: ['DEBIT', 'CREDIT'] } } },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$amount' }
      }
    }
  ]);

  const totals = {};
  result.forEach((r) => { totals[r._id] = r.total; });

  const debitTotal = totals['DEBIT'] || 0;
  const creditTotal = totals['CREDIT'] || 0;

  return {
    debitTotal,
    creditTotal,
    balanced: debitTotal === creditTotal
  };
}

module.exports = { getBalance, postDoubleEntry, postHold, releaseHold, checkLedgerInvariant };
