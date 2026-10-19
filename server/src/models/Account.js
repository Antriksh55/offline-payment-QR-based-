const mongoose = require('mongoose');

// CRITICAL DESIGN: No balance field. Balance is always derived by aggregating
// LedgerEntry documents — see getBalance() in ledger/index.js.
// Storing balance as a mutable number creates consistency risks during concurrent
// transactions and makes reconciliation error-prone. We derive it instead.
const accountSchema = new mongoose.Schema({
  accountNumber: { type: String, required: true, unique: true },
  bankId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bank', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Account', accountSchema);
