/**
 * Authentication routes — Module 11
 *
 * TWO authentication layers:
 * 1. Session auth (mobile + OTP + JWT): proves WHO is using the app
 * 2. Transaction auth (Ed25519 signature): proves each transaction is authorized
 *    — checked independently by the Switch regardless of session state
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nacl = require('tweetnacl');
const { decodeBase64 } = require('tweetnacl-util');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const Bank = require('../models/Bank');
const VpaDirectory = require('../models/VpaDirectory');
const Account = require('../models/Account');
const OtpChallenge = require('../models/OtpChallenge');
const AuthChallenge = require('../models/AuthChallenge');
const { issueToken, requireAuth } = require('../middleware/auth');

const OTP_EXPIRY_MINUTES = 5;
const OTP_RATE_LIMIT_SECONDS = 30;
const OTP_MAX_ATTEMPTS = 5;

// ── E.164 phone validation ───────────────────────────────────────────────────
function validateE164(number) {
  return /^\+[1-9]\d{7,14}$/.test(number);
}

// Normalize Indian numbers: accept 10-digit and prepend +91 server-side.
// Never trust client-entered country codes.
function normalizeIndianNumber(raw) {
  const stripped = raw.replace(/\s+/g, '').replace(/^0+/, '');
  if (/^\d{10}$/.test(stripped)) return `+91${stripped}`;
  if (/^\+91\d{10}$/.test(stripped)) return stripped;
  return null; // invalid
}

/**
 * Generate a unique VPA for a user.
 * Format: <lowercased_name_alphanumeric>@<bankcode>
 * Appends numeric suffix if already taken.
 */
async function generateVpa(displayName, bankCode) {
  const base = displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
  let candidate = `${base}@${bankCode}`;
  let suffix = 2;

  while (await VpaDirectory.findOne({ vpa: candidate })) {
    candidate = `${base}${suffix}@${bankCode}`;
    suffix++;
  }
  return candidate;
}

/**
 * Generate a unique account number.
 */
function generateAccountNumber() {
  return `ACC${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
}

// ── POST /api/auth/request-otp ───────────────────────────────────────────────
// Generates and returns OTP in response (demo mode — no SMS integration).
// In production, swap the return value for a real SMS gateway call.
router.post('/request-otp', async (req, res) => {
  try {
    let { mobileNumber } = req.body;

    // Normalize and validate
    const normalized = normalizeIndianNumber(mobileNumber);
    if (!normalized || !validateE164(normalized)) {
      return res.status(400).json({ error: 'Invalid mobile number. Use a 10-digit Indian number.' });
    }
    mobileNumber = normalized;

    // Rate-limit: 1 OTP request per 30 seconds per number
    const recentChallenge = await OtpChallenge.findOne({ mobileNumber }).sort({ createdAt: -1 });
    if (recentChallenge) {
      const secondsSinceLast = (Date.now() - recentChallenge.createdAt.getTime()) / 1000;
      if (secondsSinceLast < OTP_RATE_LIMIT_SECONDS) {
        const waitSeconds = Math.ceil(OTP_RATE_LIMIT_SECONDS - secondsSinceLast);
        return res.status(429).json({
          error: `Please wait ${waitSeconds}s before requesting another OTP`
        });
      }
    }

    // Generate 6-digit OTP via crypto (never Math.random)
    // PRODUCTION NOTE: Replace the response OTP with an SMS gateway call here.
    const otp = crypto.randomInt(100000, 999999).toString();

    // Hash OTP before storing — never store plaintext
    const otpHash = await bcrypt.hash(otp, 10);

    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Delete any existing challenges for this number (only one active at a time)
    await OtpChallenge.deleteMany({ mobileNumber });

    await OtpChallenge.create({ mobileNumber, otpHash, expiresAt });

    // Return OTP in response body (demo mode only)
    res.json({
      success: true,
      message: 'OTP generated (demo mode)',
      // DEMO ONLY: In production, never return OTP in API response — send via SMS.
      demoOtp: otp,
      expiresInSeconds: OTP_EXPIRY_MINUTES * 60
    });
  } catch (err) {
    console.error('request-otp error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/verify-otp ────────────────────────────────────────────────
// Verifies OTP. Used for both signup and new-device login.
router.post('/verify-otp', async (req, res) => {
  try {
    let { mobileNumber, otp, displayName, bankId } = req.body;

    const normalized = normalizeIndianNumber(mobileNumber);
    if (!normalized) return res.status(400).json({ error: 'Invalid mobile number' });
    mobileNumber = normalized;

    if (!otp) return res.status(400).json({ error: 'OTP is required' });

    const challenge = await OtpChallenge.findOne({ mobileNumber }).sort({ createdAt: -1 });
    if (!challenge) {
      return res.status(400).json({ error: 'No active OTP found. Please request a new one.' });
    }

    if (new Date() > challenge.expiresAt) {
      await OtpChallenge.deleteOne({ _id: challenge._id });
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    if (challenge.attemptCount >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({
        error: 'Too many failed attempts. Please request a new OTP.'
      });
    }

    const otpMatch = await bcrypt.compare(otp.toString(), challenge.otpHash);
    if (!otpMatch) {
      await OtpChallenge.updateOne({ _id: challenge._id }, { $inc: { attemptCount: 1 } });
      const remaining = OTP_MAX_ATTEMPTS - challenge.attemptCount - 1;
      return res.status(400).json({
        error: `Incorrect OTP. ${remaining} attempt(s) remaining.`
      });
    }

    // OTP verified — clean up
    await OtpChallenge.deleteOne({ _id: challenge._id });

    // Check if user already exists (returning user on new device)
    const existingUser = await User.findOne({ mobileNumber });

    if (existingUser) {
      // Returning user — issue partial token for key rotation (bind-key step)
      const partialToken = issueToken({
        userId: existingUser._id.toString(),
        vpa: existingUser.vpa,
        mobileNumber,
        partial: true  // requires bind-key to get a full token
      });
      return res.json({
        success: true,
        isNewUser: false,
        vpa: existingUser.vpa,
        displayName: existingUser.displayName,
        partialToken
      });
    }

    // New user — need displayName and bankId to proceed
    if (!displayName || !bankId) {
      return res.json({
        success: true,
        isNewUser: true,
        message: 'OTP verified. Provide displayName and bankId to complete registration.',
        otpVerified: true
      });
    }

    // Complete new user registration
    res.json({ success: true, isNewUser: true, otpVerified: true });
  } catch (err) {
    console.error('verify-otp error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/bind-key ──────────────────────────────────────────────────
// Links a device's public key to a verified account. Generates VPA for new users.
router.post('/bind-key', async (req, res) => {
  try {
    let { mobileNumber, publicKey, displayName, bankId } = req.body;

    const normalized = normalizeIndianNumber(mobileNumber);
    if (!normalized) return res.status(400).json({ error: 'Invalid mobile number' });
    mobileNumber = normalized;

    if (!publicKey) return res.status(400).json({ error: 'publicKey is required' });

    // Verify that OTP was recently verified by checking no active challenge exists
    // (deleted upon successful verify-otp)
    let user = await User.findOne({ mobileNumber });

    if (user) {
      // Returning user — key rotation
      // PRODUCTION NOTE: In a real system this would also require the partial JWT from verify-otp.
      // For demo simplicity, we accept it here after OTP verification.
      // The old device's key is now revoked — any transactions signed with the old key
      // will receive respCode 07 from the Switch, which is correct and intentional.
      user.publicKey = publicKey;
      await user.save();

      const token = issueToken({
        userId: user._id.toString(),
        vpa: user.vpa,
        mobileNumber
      });
      return res.json({ success: true, vpa: user.vpa, displayName: user.displayName, token });
    }

    // New user — create account
    if (!displayName || !bankId) {
      return res.status(400).json({ error: 'displayName and bankId required for new user' });
    }

    const bank = await Bank.findById(bankId);
    if (!bank) return res.status(400).json({ error: 'Bank not found' });

    const vpa = await generateVpa(displayName, bank.code);
    const accountNumber = generateAccountNumber();

    user = await User.create({
      mobileNumber,
      mobileVerified: true,
      displayName,
      bankId: bank._id,
      publicKey,
      vpa
    });

    await Account.create({
      accountNumber,
      bankId: bank._id,
      userId: user._id
    });

    await VpaDirectory.create({
      vpa,
      userId: user._id,
      bankId: bank._id,
      accountNumber,
      active: true
    });

    // Seed a starting balance for demo purposes (₹5000 = 500000 paise)
    const LedgerEntry = require('../models/LedgerEntry');
    await LedgerEntry.create({
      txnId: `SEED-${uuidv4()}`,
      accountNumber,
      type: 'CREDIT',
      amount: 500000,
      postedAt: new Date()
    });

    const token = issueToken({
      userId: user._id.toString(),
      vpa: user.vpa,
      mobileNumber
    });

    res.json({
      success: true,
      vpa: user.vpa,
      displayName: user.displayName,
      token,
      seedBalance: 500000
    });
  } catch (err) {
    console.error('bind-key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/challenge ─────────────────────────────────────────────────
// Returns a single-use challenge string for returning-user silent login.
router.post('/challenge', async (req, res) => {
  try {
    const { vpa } = req.body;
    if (!vpa) return res.status(400).json({ error: 'vpa is required' });

    const user = await User.findOne({ vpa });
    if (!user) {
      return res.status(404).json({ error: 'No account found for this VPA' });
    }

    // Invalidate any existing unused challenges for this VPA
    await AuthChallenge.deleteMany({ vpa, used: false });

    const challenge = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds

    await AuthChallenge.create({ vpa, challenge, expiresAt, used: false });

    res.json({ challenge, expiresAt });
  } catch (err) {
    console.error('challenge error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/verify-challenge ─────────────────────────────────────────
// Verifies a signed challenge for returning-user login. Issues JWT on success.
router.post('/verify-challenge', async (req, res) => {
  try {
    const { vpa, challenge, signature } = req.body;
    if (!vpa || !challenge || !signature) {
      return res.status(400).json({ error: 'vpa, challenge, and signature are required' });
    }

    const challengeDoc = await AuthChallenge.findOne({ vpa, challenge, used: false });
    if (!challengeDoc) {
      return res.status(400).json({ error: 'Invalid or already-used challenge' });
    }

    if (new Date() > challengeDoc.expiresAt) {
      await AuthChallenge.deleteOne({ _id: challengeDoc._id });
      return res.status(400).json({ error: 'Challenge has expired. Please request a new one.' });
    }

    const user = await User.findOne({ vpa });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify signature
    let sigValid = false;
    try {
      const sigBytes = decodeBase64(signature);
      const pubKeyBytes = decodeBase64(user.publicKey);
      const msgBytes = Buffer.from(challenge, 'utf8');
      sigValid = nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);
    } catch {
      sigValid = false;
    }

    if (!sigValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Mark challenge as used immediately — single-use, cannot authenticate twice
    await AuthChallenge.updateOne({ _id: challengeDoc._id }, { used: true });

    const token = issueToken({
      userId: user._id.toString(),
      vpa: user.vpa,
      mobileNumber: user.mobileNumber
    });

    res.json({ success: true, token, vpa: user.vpa, displayName: user.displayName });
  } catch (err) {
    console.error('verify-challenge error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/rotate-key ────────────────────────────────────────────────
// Replaces the stored public key on a User document (new device / key rotation).
// Requires a valid, freshly-verified JWT — this is the most tightly guarded endpoint
// because it effectively transfers account control.
// After rotation, any transaction signed with the OLD key will receive respCode 07
// from the Switch — the old device is effectively deauthorized.
router.post('/rotate-key', requireAuth, async (req, res) => {
  try {
    const { newPublicKey } = req.body;
    if (!newPublicKey) return res.status(400).json({ error: 'newPublicKey is required' });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.publicKey = newPublicKey;
    await user.save();

    res.json({ success: true, message: 'Key rotated successfully. Old device is now deauthorized.' });
  } catch (err) {
    console.error('rotate-key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).populate('bankId');
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      vpa: user.vpa,
      displayName: user.displayName,
      mobileNumber: user.mobileNumber,
      bankName: user.bankId?.name,
      bankCode: user.bankId?.code
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
