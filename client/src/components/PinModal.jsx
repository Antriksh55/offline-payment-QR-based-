/**
 * PinModal — UPI PIN verification dialog
 *
 * Shown before every QR payment is generated.
 * Verifies PIN locally via SHA-256 hash comparison — no server call, works offline.
 * Locks out after 5 wrong attempts (in-memory; resets on page reload for demo).
 */

import { useState, useRef, useEffect } from 'react';
import { verifyPin, hasPin } from '../identity/keyStore';
import '../styles/pin-modal.css';

const MAX_ATTEMPTS = 5;

export default function PinModal({ onSuccess, onCancel, amountDisplay }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [locked, setLocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    // Auto-focus the PIN input when modal opens
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (locked || checking) return;

    setChecking(true);
    setError('');

    try {
      const pinSet = await hasPin();
      if (!pinSet) {
        // No PIN set — this shouldn't happen in normal flow, but handle gracefully
        onSuccess();
        return;
      }

      const correct = await verifyPin(pin);

      if (correct) {
        onSuccess();
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        setPin('');

        if (newAttempts >= MAX_ATTEMPTS) {
          setLocked(true);
          setError(`Too many wrong attempts. Please restart the app.`);
        } else {
          setError(`Incorrect PIN. ${MAX_ATTEMPTS - newAttempts} attempt(s) remaining.`);
          setTimeout(() => inputRef.current?.focus(), 50);
        }
      }
    } catch (err) {
      setError('PIN verification failed: ' + err.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="pin-overlay" role="dialog" aria-modal="true" aria-label="Enter UPI PIN">
      <div className="pin-modal">
        <div className="pin-modal-header">
          <div className="pin-lock-icon">🔐</div>
          <h3>Enter UPI PIN</h3>
          {amountDisplay && (
            <p className="pin-amount">Authorising payment of <strong>{amountDisplay}</strong></p>
          )}
          <p className="pin-offline-note">✓ Verified offline — no internet needed</p>
        </div>

        <form onSubmit={handleSubmit} className="pin-form">
          {/* Dot display */}
          <div className="pin-dots" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={`pin-dot ${pin.length > i ? 'filled' : ''}`} />
            ))}
          </div>

          {/* Hidden actual input */}
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => {
              if (!locked) setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
            }}
            className="pin-hidden-input"
            aria-label="UPI PIN"
            autoComplete="current-password"
            disabled={locked || checking}
          />

          {error && <div className="pin-error" role="alert">{error}</div>}

          <div className="pin-actions">
            <button
              type="button"
              className="btn-pin-cancel"
              onClick={onCancel}
              disabled={checking}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-pin-confirm"
              disabled={pin.length < 4 || locked || checking}
            >
              {checking ? '…' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
