const mongoose = require('mongoose');

// Models a real interbank settlement batch (like NEFT/RTGS batching).
// Individual transactions post to the ledger immediately (PENDING_SETTLEMENT),
// but money movement between banks is calculated and finalized periodically
// here, not per-transaction.
const settlementBatchSchema = new mongoose.Schema({
  runAt: { type: Date, default: Date.now },
  // Array of exactly 2 bank IDs involved in this netting
  bankPair: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Bank' }],
  // Net amount owed from bankPair[0] to bankPair[1]; negative means flow is reversed
  netAmount: { type: Number, required: true },
  // IDs of all Transaction documents included in this batch
  txnIds: [{ type: String }]
});

module.exports = mongoose.model('SettlementBatch', settlementBatchSchema);
