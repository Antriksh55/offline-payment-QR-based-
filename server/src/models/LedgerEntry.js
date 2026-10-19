const mongoose = require('mongoose');

// Every financial movement is recorded here. Account balance is NEVER stored
// as a mutable field — it is always derived by aggregating these entries.
// SUM(CREDIT amounts) - SUM(DEBIT amounts) - SUM(active HOLD amounts) = available balance.
//
// The double-entry invariant: SUM(all DEBITs) must always equal SUM(all CREDITs)
// across the whole ledger. A HOLD is not a debit — it becomes a DEBIT only when
// reconciled after offline sync.
const ledgerEntrySchema = new mongoose.Schema({
  txnId: { type: String, required: true, index: true },
  accountNumber: { type: String, required: true },
  // DEBIT: money leaving the account
  // CREDIT: money entering the account
  // HOLD: reserved for offline float (not yet a real debit — reduces available balance)
  // HOLD_RELEASE: reverses an unused portion of a HOLD
  type: { type: String, enum: ['DEBIT', 'CREDIT', 'HOLD', 'HOLD_RELEASE'], required: true },
  amount: { type: Number, required: true }, // integer, smallest currency unit
  postedAt: { type: Date, default: Date.now }
});

// Compound index for efficient balance aggregation queries
ledgerEntrySchema.index({ accountNumber: 1, postedAt: 1 });

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);
