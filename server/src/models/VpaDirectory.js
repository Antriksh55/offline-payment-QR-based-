const mongoose = require('mongoose');

const vpaDirectorySchema = new mongoose.Schema({
  vpa: { type: String, required: true, unique: true, lowercase: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  bankId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bank', required: true },
  accountNumber: { type: String, required: true }, // ref Account.accountNumber
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('VpaDirectory', vpaDirectorySchema);
