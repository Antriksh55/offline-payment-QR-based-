/**
 * Registration & Login Page — Module 11 UI
 *
 * Flow:
 * 1. Enter mobile number → request OTP
 * 2. OTP displayed on-screen (demo mode — no SMS)
 * 3. Enter OTP + name + bank (if new user)
 * 4. Keys generated client-side, public key sent to backend
 * 5. JWT + VPA returned, redirected to dashboard
 */

import { useState, useEffect } from 'react';
import { getOrCreateKeypair } from '../identity/keyStore';
import { api } from '../api/client';
import '../styles/register.css';

const STEPS = {
  PHONE: 'phone',
  OTP: 'otp',
  PROFILE: 'profile',
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
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isNewUser, setIsNewUser] = useState(false);
  const [otpCountdown, setOtpCountdown] = useState(0);
  const [partialToken, setPartialToken] = useState(null);

  useEffect(() => {
    api.getBanks().then((data) => setBanks(data.banks)).catch(() => {});
  }, []);

  // OTP countdown timer
  useEffect(() => {
    if (otpCountdown > 0) {
      const timer = setTimeout(() => setOtpCountdown(otpCountdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [otpCountdown]);

  async function handleRequestOtp(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await api.requestOtp(mobileNumber);
      setDemoOtp(result.demoOtp);
      setOtpCountdown(30); // rate limit cooldown
      setStep(STEPS.OTP);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await api.verifyOtp(mobileNumber, otp);

      if (!result.isNewUser) {
        // Returning user — go straight to key binding
        setPartialToken(result.partialToken);
        setIsNewUser(false);
        setStep(STEPS.BINDING);
      } else {
        // New user — collect profile info
        setIsNewUser(true);
        setStep(STEPS.PROFILE);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCompleteRegistration(e) {
    e.preventDefault();
    if (!displayName.trim()) { setError('Display name is required'); return; }
    if (!bankId) { setError('Please choose a bank'); return; }
    setError('');
    setLoading(true);
    try {
      const keypair = await getOrCreateKeypair();
      const result = await api.bindKey(mobileNumber, keypair.publicKeyB64, displayName, bankId);

      onLogin(result.token, result.vpa, result.displayName);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleNewDeviceBind(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // Generate a new keypair for this device
      const keypair = await getOrCreateKeypair();

      // Temporarily set auth token to partial token so api.bindKey sends it
      if (partialToken) localStorage.setItem('authToken', partialToken);

      const result = await api.bindKey(mobileNumber, keypair.publicKeyB64);
      onLogin(result.token, result.vpa, result.displayName);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="register-page">
      <div className="register-card">
        <div className="register-logo">
          <span className="logo-icon">₹</span>
          <h1>OfflinePay</h1>
          <p className="logo-subtitle">Offline QR Payments</p>
        </div>

        {/* STEP 1: Phone Number */}
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

        {/* STEP 2: OTP Entry */}
        {step === STEPS.OTP && (
          <form onSubmit={handleVerifyOtp} className="register-form">
            <h2>Enter OTP</h2>

            {/* Demo-mode OTP banner — this is the on-screen OTP per spec */}
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

        {/* STEP 3a: New user profile */}
        {step === STEPS.PROFILE && (
          <form onSubmit={handleCompleteRegistration} className="register-form">
            <h2>Complete Registration</h2>
            <p className="step-hint">Choose your display name and bank</p>

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

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>
        )}

        {/* STEP 3b: Returning user new device */}
        {step === STEPS.BINDING && (
          <form onSubmit={handleNewDeviceBind} className="register-form">
            <h2>New Device Detected</h2>
            <p className="step-hint">
              We'll generate a new key for this device. Your old device will be deauthorized.
            </p>
            {error && <div className="error-msg" role="alert">{error}</div>}
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Binding key...' : 'Authorize This Device'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
