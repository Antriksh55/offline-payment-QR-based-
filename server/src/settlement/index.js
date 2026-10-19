/**
 * Settlement Batch Job — Module 9
 *
 * Simulates real interbank settlement (like NEFT/RTGS batching).
 * Individual transactions post to the ledger immediately (PENDING_SETTLEMENT),
 * but actual money movement between banks is calculated and finalized here,
 * periodically, not per-transaction.
 */

const Transaction = require('../models/Transaction');
const VpaDirectory = require('../models/VpaDirectory');
const Bank = require('../models/Bank');
const SettlementBatch = require('../models/SettlementBatch');

/**
 * Run settlement for all PENDING_SETTLEMENT transactions.
 * Groups by bank pair, nets out amounts, creates SettlementBatch documents,
 * and marks transactions as SETTLED.
 *
 * @returns {{ batches: Array, txnsSettled: number }}
 */
async function runSettlement() {
  const pending = await Transaction.find({ status: 'PENDING_SETTLEMENT' });

  if (pending.length === 0) {
    return { batches: [], txnsSettled: 0 };
  }

  // Build a map of vpa -> bankId for all VPAs in the pending set
  const allVpas = new Set();
  pending.forEach((t) => {
    allVpas.add(t.senderVpa);
    allVpas.add(t.receiverVpa);
  });

  const vpaEntries = await VpaDirectory.find({ vpa: { $in: Array.from(allVpas) } });
  const vpaToBankId = {};
  vpaEntries.forEach((v) => {
    vpaToBankId[v.vpa] = v.bankId.toString();
  });

  // Group transactions by ordered bank pair
  // Key: "<smallerBankId>|<largerBankId>"
  // Value: { bankA: id, bankB: id, txns: [], netAmount: 0 }
  // netAmount > 0 means bankA owes bankB that amount
  const pairMap = {};

  for (const txn of pending) {
    const senderBank = vpaToBankId[txn.senderVpa];
    const receiverBank = vpaToBankId[txn.receiverVpa];

    if (!senderBank || !receiverBank) continue;

    // Same bank — no interbank netting needed
    if (senderBank === receiverBank) {
      // Still mark as SETTLED, just no batch needed
      await Transaction.updateOne({ _id: txn._id }, { status: 'SETTLED' });
      continue;
    }

    // Canonical key: smaller ID first, so A→B and B→A land in the same bucket
    const [bankA, bankB] = [senderBank, receiverBank].sort();
    const key = `${bankA}|${bankB}`;

    if (!pairMap[key]) {
      pairMap[key] = { bankA, bankB, txns: [], netAmount: 0 };
    }

    // If sender is bankA, bankA owes bankB → positive
    // If sender is bankB, bankB owes bankA → negative from bankA's perspective
    const sign = senderBank === bankA ? 1 : -1;
    pairMap[key].netAmount += sign * txn.amount;
    pairMap[key].txns.push(txn);
  }

  // Create SettlementBatch per pair and mark transactions SETTLED
  const createdBatches = [];
  for (const key of Object.keys(pairMap)) {
    const { bankA, bankB, txns, netAmount } = pairMap[key];

    const batch = await SettlementBatch.create({
      runAt: new Date(),
      bankPair: [bankA, bankB],
      netAmount,
      txnIds: txns.map((t) => t.txnId)
    });

    await Transaction.updateMany(
      { txnId: { $in: txns.map((t) => t.txnId) } },
      { status: 'SETTLED' }
    );

    createdBatches.push(batch);
  }

  const txnsSettled = pending.length;
  return { batches: createdBatches, txnsSettled };
}

module.exports = { runSettlement };
