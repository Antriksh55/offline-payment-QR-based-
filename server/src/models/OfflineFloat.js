const mongoose = require('mongoose');

// Offline Float (Escrow) — Module 12.
//
// DESIGN NOTE: Offline double-spend detection is inherently reactive unless the
// server pre-reserves (escrows) funds before the device goes offline. This model
// implements the same technique as EMV floor limits and RBI's offline UPI framework:
// a server-set spending cap that is *already deducted from available balance* via a
// HOLD ledger entry at issuance time. This makes the maximum possible offline damage
// bounded and known before the device ever disconnects.
//
// IMPORTANT: This does NOT make offline double-spending impossible — that is not
// achievable with pure software and no trusted hardware security element (HSE/TEE).
// The guarantee is "maximum damage is capped at reservedAmount," not "impossible."
// A malicious actor with physical device access could still attempt a hardware rollback.
const offlineFloatSchema = new mongoose.Schema({
  accountNumber: { type: String, required: true, index: true },
  reservedAmount: { type: Number, required: true }, // total escrowed (HOLD posted)
  spentSoFar: { type: Number, default: 0 },          // reconciled from deviceSeq log on sync
  issuedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },          // hard TTL, 24 hours from issuedAt
  deviceId: { type: String, required: true },
  // startingSeq: the deviceSeq value from which this float's transactions begin
  startingSeq: { type: Number, required: true },
  // highestReconciled: the highest deviceSeq successfully reconciled so far
  highestReconciled: { type: Number, default: null },
  // holdTxnId: the txnId of the HOLD ledger entry, used for release on reconciliation
  holdTxnId: { type: String, required: true },
  status: { type: String, enum: ['ACTIVE', 'RECONCILED', 'EXPIRED'], default: 'ACTIVE' }
});

// Unique partial index: only one ACTIVE float per account at a time.
// Prevents two trusted devices simultaneously holding a float on the same account
// (which would let them both spend the same reserved funds offline).
offlineFloatSchema.index(
  { accountNumber: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } }
);

module.exports = mongoose.model('OfflineFloat', offlineFloatSchema);
