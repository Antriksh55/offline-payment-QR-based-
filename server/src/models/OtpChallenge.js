const mongoose = require('mongoose');

const otpChallengeSchema = new mongoose.Schema({
  mobileNumber: { type: String, required: true, index: true },
  // Never store OTP plaintext — we store bcrypt/SHA-256 hash
  otpHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },  // 5 minutes from creation
  attemptCount: { type: Number, default: 0 }, // incremented on each wrong guess
  // Track last request time for rate-limiting (1 request per 30s)
  lastRequestAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

// TTL index — MongoDB will auto-delete expired OTP documents
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OtpChallenge', otpChallengeSchema);
