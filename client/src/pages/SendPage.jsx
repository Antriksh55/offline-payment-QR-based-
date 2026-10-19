/**
 * Send Page — Module 10 UI + Module 3 (QR Generation)
 *
 * Flow:
 *   1. Enter amount → Generate QR (transaction recorded as PENDING_SCAN — does NOT affect balance)
 *   2. Receiver scans QR → Sender taps "Confirm Sent" → status moves to PENDING_SYNC (balance deducted)
 *   3. OR sender taps "Cancel" → status set to CANCELLED, balance unchanged
 *
 * The balance only decreases once the sender explicitly confirms the receiver scanned.
 * Generating a QR and then backing out leaves the balance untouched.
 */

import { useState, useEffect } from 'react';
import { buildSignedTransaction, validateAmount } from '../transaction/builder';
import { generateQRCode } from '../qr/qrGenerator';
import {
  recordSentTransaction,
  confirmSentTransaction,
  cancelSentTransaction,
  computeLocalBalance,
  getWalletMeta,
  updateWalletMeta
} from '../ledger/localLedger';
import { getKeypair } from '../identity/keyStore';
import '../styles/send.css';

export default function SendPage({ user, onBack, deviceId }) {
  const [amountRupees, setAmountRupees] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [signedTxn, setSignedTxn] = useState(null);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState(0);
  const [floatMeta, setFloatMeta] = useState(null);
  const [confirmed, setConfirmed] = useState(false); // true after sender taps "Receiver scanned it"

  useEffect(() => {
    computeLocalBalance().then(({ balance: b }) => setBalance(b));
    getWalletMeta().then((meta) => setFloatMeta(meta));
  }, []);

  async function handleGenerate(e) {
    e.preventDefault();
    setError('');
    setWarning('');
    setQrDataUrl(null);
    setConfirmed(false);

    const paise = Math.round(parseFloat(amountRupees) * 100);
    if (isNaN(paise)) { setError('Please enter a valid amount'); return; }

    const validationResult = validateAmount(paise, balance);
    if (validationResult) {
      if (validationResult.startsWith('__WARN__:')) {
        setWarning(validationResult.replace('__WARN__:', ''));
      } else {
        setError(validationResult);
        return;
      }
    }

    // Offline float guard (client-side UX only — real protection is server-side HOLD)
    if (floatMeta?.floatReservedAmount && floatMeta?.floatExpiresAt) {
      const expiresAt = new Date(floatMeta.floatExpiresAt);
      const spentSoFar = floatMeta.floatSpentOffline || 0;
      if (new Date() > expiresAt) {
        setError('Your offline spending limit has expired. Reconnect to refresh it.');
        return;
      }
      if (spentSoFar + paise > floatMeta.floatReservedAmount) {
        setError(
          `Offline spending limit reached (₹${(floatMeta.floatReservedAmount / 100).toFixed(2)} total). ` +
          `Reconnect to refresh your limit.`
        );
        return;
      }
    }

    setLoading(true);
    try {
      const keypair = await getKeypair();
      if (!keypair) { setError('No keys found. Please re-register.'); return; }

      let deviceSeq = undefined;
      if (floatMeta?.floatNextSeq !== undefined) {
        deviceSeq = floatMeta.floatNextSeq;
        await updateWalletMeta({
          floatNextSeq: deviceSeq + 1,
          floatSpentOffline: (floatMeta.floatSpentOffline || 0) + paise
        });
      }

      const txn = buildSignedTransaction({
        senderVpa: user.vpa,
        amount: paise,
        privateKeyB64: keypair.privateKeyB64,
        publicKeyB64: keypair.publicKeyB64,
        deviceId: deviceId || undefined,
        deviceSeq
      });

      // Record as PENDING_SCAN — balance does NOT change yet
      await recordSentTransaction(txn);

      const dataUrl = await generateQRCode(txn);
      setQrDataUrl(dataUrl);
      setSignedTxn(txn);
    } catch (err) {
      setError(`Failed to generate QR: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Sender confirms the receiver scanned the QR → move to PENDING_SYNC (balance now deducted)
  async function handleConfirmSent() {
    try {
      await confirmSentTransaction(signedTxn.txnId);
      setConfirmed(true);
      // Refresh balance display
      const { balance: newBal } = await computeLocalBalance();
      setBalance(newBal);
    } catch (err) {
      setError(`Failed to confirm: ${err.message}`);
    }
  }

  // User cancels — removes the debit from balance, marks CANCELLED
  async function handleCancel() {
    if (signedTxn) {
      await cancelSentTransaction(signedTxn.txnId);
    }
    setQrDataUrl(null);
    setSignedTxn(null);
    setAmountRupees('');
    setError('');
    setWarning('');
    setConfirmed(false);
    // Refresh balance
    const { balance: newBal } = await computeLocalBalance();
    setBalance(newBal);
  }

  // New transaction after confirming
  async function handleNewTransaction() {
    setQrDataUrl(null);
    setSignedTxn(null);
    setAmountRupees('');
    setError('');
    setWarning('');
    setConfirmed(false);
    const { balance: newBal } = await computeLocalBalance();
    setBalance(newBal);
  }

  const fmt = (p) => `₹${(p / 100).toFixed(2)}`;

  return (
    <div className="send-page">
      <header className="page-header">
        <button className="btn-back" onClick={signedTxn && !confirmed ? handleCancel : onBack} aria-label="Back">←</button>
        <h2>Send Money</h2>
      </header>

      {/* ── Step 1: Amount entry ── */}
      {!qrDataUrl && (
        <form onSubmit={handleGenerate} className="send-form">
          <div className="balance-hint">
            Balance: <strong>{fmt(balance)}</strong>
          </div>

          {floatMeta?.floatReservedAmount && (
            <div className="float-info">
              Offline limit: {fmt(floatMeta.floatReservedAmount - (floatMeta.floatSpentOffline || 0))} remaining
            </div>
          )}

          <div className="amount-input-wrap">
            <span className="currency-symbol">₹</span>
            <input
              type="number"
              placeholder="0.00"
              value={amountRupees}
              onChange={(e) => setAmountRupees(e.target.value)}
              min="0.01"
              step="0.01"
              required
              className="amount-input"
              aria-label="Amount in rupees"
            />
          </div>

          {warning && <div className="warning-msg" role="alert">⚠️ {warning}</div>}
          {error && <div className="error-msg" role="alert">{error}</div>}

          <button type="submit" className="btn-primary" disabled={loading || !amountRupees}>
            {loading ? 'Generating QR...' : 'Generate QR Code'}
          </button>
        </form>
      )}

      {/* ── Step 2: QR display — waiting for receiver to scan ── */}
      {qrDataUrl && !confirmed && (
        <div className="qr-display">
          <div className="qr-status-banner pending">
            📱 Show this QR to the recipient — it's valid for <strong>5 minutes</strong>
          </div>

          <div className="qr-container">
            <img src={qrDataUrl} alt="Payment QR Code" className="qr-image" />
          </div>

          <div className="txn-summary">
            <div className="summary-row">
              <span>Amount</span>
              <strong>{fmt(signedTxn.amount)}</strong>
            </div>
            <div className="summary-row">
              <span>From</span>
              <strong>{signedTxn.senderVpa}</strong>
            </div>
            <div className="summary-row">
              <span>Transaction ID</span>
              <code className="txn-id">{signedTxn.txnId.slice(0, 8)}…</code>
            </div>
            <div className="summary-row">
              <span>Status</span>
              <span className="status-tag pending-scan">Waiting for scan…</span>
            </div>
          </div>

          {error && <div className="error-msg" role="alert">{error}</div>}

          {/* Sender confirms receiver has scanned */}
          <button className="btn-primary confirm-btn" onClick={handleConfirmSent}>
            ✓ Receiver Scanned — Confirm Payment
          </button>

          {/* Cancel — removes the pending entry, balance stays unchanged */}
          <button className="btn-cancel" onClick={handleCancel}>
            ✕ Cancel — Receiver Didn't Scan
          </button>

          <p className="cancel-hint">
            Your balance won't change until you tap "Confirm Payment" above.
          </p>
        </div>
      )}

      {/* ── Step 3: Confirmed ── */}
      {qrDataUrl && confirmed && (
        <div className="qr-display">
          <div className="qr-status-banner success">
            ✅ Payment recorded — sync when online to confirm on the server
          </div>

          <div className="txn-summary">
            <div className="summary-row">
              <span>Amount sent</span>
              <strong className="amount-sent">{fmt(signedTxn.amount)}</strong>
            </div>
            <div className="summary-row">
              <span>From</span>
              <strong>{signedTxn.senderVpa}</strong>
            </div>
            <div className="summary-row">
              <span>New balance</span>
              <strong>{fmt(balance)}</strong>
            </div>
            <div className="summary-row">
              <span>Status</span>
              <span className="status-tag pending-sync">Pending Sync</span>
            </div>
          </div>

          <button className="btn-secondary" onClick={handleNewTransaction}>
            Send Another
          </button>
          <button className="btn-link" onClick={onBack}>
            Back to Dashboard
          </button>
        </div>
      )}
    </div>
  );
}
