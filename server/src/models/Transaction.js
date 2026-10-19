const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  txnId: { type: String, required: true, unique: true },
  senderVpa: { type: String, required: true },
  receiverVpa: { type: String, required: true },
  amount: { type: Number, required: true }, // in smallest currency unit (paise), integer only
  initiationMode: { type: String, enum: ['ONLINE', 'OFFLINE_QR'], default: 'OFFLINE_QR' },
  timestamp: { type: Number, required: true }, // ms since epoch (from client)
  // nonce has a unique index — this is the database-level backstop against QR replay,
  // independent of the application-level nonce check in the Switch
  nonce: { type: String, required: true, unique: true },
  // deviceSeq: strictly increasing per-device counter, signed as part of the transaction.
  // Used during offline float reconciliation to detect device-restore/rollback replay attacks
  // that a random nonce alone cannot catch.
  deviceSeq: { type: Number, default: null },
  deviceId: { type: String, default: null },
  respCode: { type: String, default: null },
  respMessage: { type: String, default: null },
  status: {
    type: String,
    enum: ['INITIATED', 'PENDING_SETTLEMENT', 'SETTLED', 'REJECTED'],
    default: 'INITIATED'
  },
  createdAt: { type: Date, default: Date.now }
});

// Compound index for efficient float-based deviceSeq range queries
transactionSchema.index({ deviceId: 1, deviceSeq: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
