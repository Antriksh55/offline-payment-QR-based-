/**
 * Registration & Login Page — Module 11 UI
 *
 * Flow (new user):
 *   1. Enter mobile number → request OTP
 *   2. OTP displayed on-screen (demo mode)
 *   3. Enter OTP → if new user go to PROFILE, if returning user go to BINDING
 *   4. Enter name + bank → go to PIN setup
 *   5. Set 4–6 digit UPI PIN (stored hashed in IndexedDB — works offline)
 *   6. Generate keypair, bind key to server → dashboard
 *
 * Flow (returning user, same device): silent challenge/response — no steps shown
 * Flow (returning user, new device): OTP → BINDING → PIN setup → dashboard
 */

import { useState, useEffect } from 'react';
import { getOrCreateKeypair } from '../identity/keyStore';
import { savePin } from '../identity/keyStore';
import { api } from '../api/client';
import '../styles/register.css';

const STEPS = {
  PHONE: 'phone',
  OTP: 'otp',
  PROFILE: 'profile',
  PIN: 'pin',
  BINDING: 'binding'
};

export default function RegisterPage({ onLogin }) {
  const [step, setStep] = useState(STEPS.PHONE);
  const [mobileNumber, setMobileNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [demoOtp, setDemoOtp] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [bankId, setBankId] = useState('');
  const [banks, setBanks] = useState([]);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [otpCountdown, setOtpCountdown] = useState(0);
  const [partialToken, setPartialToken] = useState(null);
  const [isNewUser, setIsNewUser] = useState(false);
  // Store resolved profile before PIN step (for new users)
  const [pendingProfile, setPendingProfile] = useState(null);

  useEffect(() => {
    api.getBanks().then((data) => setBanks(data.banks)).catch(() => {});
  }, []);

  useEffect(() => {
    if (otpCountdown > 0) {
      const timer = setTimeout(() => setOtpCountdown(otpCountdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [otpCountdown]);

  // ── Step 1: Request OTP ────────────────────────────────────────────────────
  async function handleRequestOtp(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await api.requestOtp(mobileNumber);
      setDemoOtp(result.demoOtp);
      setOtpCountdown(30);
      setStep(STEPS.OTP);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Step 2: Verify OTP ─────────────────────────────────────────────────────
  async function handleVerifyOtp(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await api.verifyOtp(mobileNumber, otp);
      if (!result.isNewUser) {
        setPartialToken(result.partialToken);
        setIsNewUser(false);
        setStep(STEPS.BINDING);
      } else {
        setIsNewUser(true);
        setStep(STEPS.PROFILE);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Step 3: Profile (new user) → then go to PIN ────────────────────────────
  function handleProfileNext(e) {
    e.preventDefault();
    if (!displayName.trim()) { setError('Display name is required'); return; }
    if (!bankId) { setError('Please choose a bank'); return; }
    setError('');
    setPendingProfile({ displayName: displayName.trim(), bankId });
    setStep(STEPS.PIN);
  }

  // ── Step 4: PIN setup ──────────────────────────────────────────────────────
  async function handleSetPin(e) {
    e.preventDefault();
    setError('');

    if (!/^\d{4,6}$/.test(pin)) {
      setError('PIN must be 4–6 digits');
      return;
    }
    if (pin !== confirmPin) {
      setError('PINs do not match');
      return;
    }

    setLoading(true);
    try {
      // Save hashed PIN to IndexedDB — works 100% offline
      await savePin(pin);

      if (isNewUser && pendingProfile) {
        // New user: bind key to server
        const keypair = await getOrCreateKeypair();
        const result = await api.bindKey(
          mobileNumber,
          keypair.publicKeyB64,
          pendingProfile.displayName,
          pendingProfile.bankId
        );
        onLogin(result.token, result.vpa, result.displayName);
      } else {
        // Returning user new device: bind new key
        const keypair = await getOrCreateKeypair();
        if (partialToken) localStorage.setItem('authToken', partialToken);
        const result = await api.bindKey(mobileNumber, keypair.publicKeyB64);
        onLogin(result.token, result.vpa, result.displayName);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Returning user new device: go through PIN setup ────────────────────────
  function handleBindingNext(e) {
    e.preventDefault();
    setError('');
    setStep(STEPS.PIN);
  }

  return (
    <div className="register-page">
      <div className="register-card">
        <div className="register-logo">
          <span className="logo-icon">₹</span>
          <h1>OfflinePay</h1>
          <p className="logo-subtitle">Offline QR Payments</p>
        </div>

        {/* ── STEP 1: Phone ── */}
        {step === STEPS.PHONE && (
          <form onSubmit={handleRequestOtp} className="register-form">
            <h2>Sign In or Register</h2>
            <p className="step-hint">Enter your 10-digit mobile number</p>
            <div className="input-group">
              <span className="input-prefix">+91</span>
              <input
                type="tel"
                placeholder="9876543210"
                value={mobileNumber}
                onChange={(e) => setMobileNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
                required
                pattern="\d{10}"
                className="phone-input"
                aria-label="Mobile number"
              />
            </div>
            {error && <div className="error-msg" role="alert">{error}</div>}
            <button type="submit" className="btn-primary" disabled={loading || mobileNumber.length !== 10}>
              {loading ? 'Sending...' : 'Get OTP'}
            </button>
          </form>
        )}

        {/* ── STEP 2: OTP ── */}
        {step === STEPS.OTP && (
          <form onSubmit={handleVerifyOtp} className="register-form">
            <h2>Enter OTP</h2>
            {demoOtp && (
              <div className="demo-otp-banner" role="status">
                <strong>Demo mode — your OTP is:</strong>
                <span className="otp-display">{demoOtp}</span>
                <small>In production, this would be sent via SMS</small>
              </div>
            )}
            <input
              type="text"
              placeholder="6-digit OTP"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
              pattern="\d{6}"
              className="otp-input"
              aria-label="One-time password"
              inputMode="numeric"
              autoComplete="one-time-code"
            />
            {error && <div className="error-msg" role="alert">{error}</div>}
            <button type="submit" className="btn-primary" disabled={loading || otp.length !== 6}>
              {loading ? 'Verifying...' : 'Verify OTP'}
            </button>
            <button
              type="button"
              className="btn-link"
              disabled={otpCountdown > 0}
              onClick={() => { setStep(STEPS.PHONE); setDemoOtp(null); setOtp(''); setError(''); }}
            >
              {otpCountdown > 0 ? `Resend in ${otpCountdown}s` : 'Resend OTP'}
            </button>
          </form>
        )}

        {/* ── STEP 3: Profile (new user) ── */}
        {step === STEPS.PROFILE && (
          <form onSubmit={handleProfileNext} className="register-form">
            <h2>Your Profile</h2>
            <p className="step-hint">Step 1 of 2 — Choose your name and bank</p>
            <input
              type="text"
              placeholder="Your name (e.g. Alice)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              className="text-input"
              aria-label="Display name"
            />
            <select
              value={bankId}
              onChange={(e) => setBankId(e.target.value)}
              required
              className="bank-select"
              aria-label="Select bank"
            >
              <option value="">Select a bank</option>
              {banks.map((b) => (
                <option key={b._id} value={b._id}>{b.name}</option>
              ))}
            </select>
            {error && <div className="error-msg" role="alert">{error}</div>}
            <button type="submit" className="btn-primary">
              Continue →
            </button>
          </form>
        )}

        {/* ── STEP 3b: Returning user new device ── */}
        {step === STEPS.BINDING && (
          <form onSubmit={handleBindingNext} className="register-form">
            <h2>New Device Detected</h2>
            <p className="step-hint">
              A new device key will be generated. Your old device will be deauthorized.
            </p>
            {error && <div className="error-msg" role="alert">{error}</div>}
            <button type="submit" className="btn-primary">
              Continue →
            </button>
          </form>
        )}

        {/* ── STEP 4: Set UPI PIN ── */}
        {step === STEPS.PIN && (
          <form onSubmit={handleSetPin} className="register-form">
            <h2>Set UPI PIN</h2>
            <p className="step-hint">
              {isNewUser ? 'Step 2 of 2 — ' : ''}
              This PIN will be required before every payment. It is stored <strong>only on this device</strong> — never sent to any server.
            </p>

            <div className="pin-field">
              <label htmlFor="pin-input">Enter PIN (4–6 digits)</label>
              <input
                id="pin-input"
                type="password"
                inputMode="numeric"
                placeholder="••••"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
                pattern="\d{4,6}"
                className="otp-input"
                aria-label="UPI PIN"
                autoComplete="new-password"
              />
            </div>

            <div className="pin-field">
              <label htmlFor="pin-confirm">Confirm PIN</label>
              <input
                id="pin-confirm"
                type="password"
                inputMode="numeric"
                placeholder="••••"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
                className="otp-input"
                aria-label="Confirm UPI PIN"
                autoComplete="new-password"
              />
            </div>

            <div className="pin-info-box">
              🔒 Your PIN is hashed with SHA-256 and stored only in this browser's IndexedDB.
              It works completely offline — no internet needed to verify.
            </div>

            {error && <div className="error-msg" role="alert">{error}</div>}

            <button type="submit" className="btn-primary" disabled={loading || pin.length < 4 || confirmPin.length < 4}>
              {loading ? 'Setting up...' : 'Set PIN & Create Account'}
            </button>
          </form>
        )}

        {/* Step indicator */}
        {(step === STEPS.PROFILE || step === STEPS.PIN) && (
          <div className="step-dots">
            <span className={`dot ${step === STEPS.PROFILE ? 'active' : 'done'}`} />
            <span className={`dot ${step === STEPS.PIN ? 'active' : ''}`} />
          </div>
        )}
      </div>
    </div>
  );
}
