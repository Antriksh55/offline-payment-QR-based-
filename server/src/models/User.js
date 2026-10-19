const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // E.164 format: +919876543210
  mobileNumber: {
    type: String,
    required: true,
    unique: true,
    validate: {
      validator: (v) => /^\+[1-9]\d{7,14}$/.test(v),
      message: 'Mobile number must be in E.164 format'
    }
  },
  mobileVerified: { type: Boolean, default: false },
  displayName: { type: String, required: true },
  bankId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bank', required: true },
  // The currently active device's public key (base64 encoded).
  // When a user rotates their key (new device), this is overwritten — the old
  // device's signed transactions will then fail respCode 07 in the Switch.
  publicKey: { type: String, required: true },
  vpa: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
