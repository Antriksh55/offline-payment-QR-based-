const mongoose = require('mongoose');

// Used for returning-user login via key-based challenge-response
// (no OTP needed on the same device — sign the challenge with your private key)
const authChallengeSchema = new mongoose.Schema({
  vpa: { type: String, required: true, index: true },
  challenge: { type: String, required: true, unique: true }, // random single-use string
  expiresAt: { type: Date, required: true }, // 60 seconds from creation
  used: { type: Boolean, default: false },   // marked true immediately after verification
  createdAt: { type: Date, default: Date.now }
});

// TTL index — auto-delete old challenges
authChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AuthChallenge', authChallengeSchema);
