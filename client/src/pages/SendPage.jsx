/**
 * Send Page — Module 10 UI + Module 3 (QR Generation)
 *
 * Flow:
 *   1. Enter amount → tap Generate
 *   2. ── UPI PIN modal (verified offline via SHA-256 in IndexedDB) ──
 *   3. On PIN success → build signed transaction, record as PENDING_SCAN (balance unchanged)
 *   4. QR displayed → receiver scans → sender taps "Confirm Payment"
 *   5. Status → PENDING_SYNC, balance deducted
 *   6. OR sender taps "Cancel" → CANCELLED, balance unchanged
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
import PinModal from '../components/PinModal';
import '../styles/send.css';

/** Small helper — copies the raw signed transaction JSON to clipboard */
function CopyPaymentData({ txn }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(txn));
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Fallback for browsers without clipboard API
      const ta = document.createElement('textarea');
      ta.value = JSON.stringify(txn);
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    }
  }

  return (
    <div className="copy-payment-box">
      <p className="copy-payment-label">
        🖥️ <strong>Desktop testing?</strong> Copy payment data and paste it on the receiver's tab
      </p>
      <button
        type="button"
        className={`btn-copy-payment ${copied ? 'copied' : ''}`}
        onClick={handleCopy}
      >
        {copied ? '✅ Copied!' : '📋 Copy Payment Data'}
      </button>
    </div>
  );
}

export default function SendPage({ user, onBack, deviceId }) {
  const [amountRupees, setAmountRupees] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [signedTxn, setSignedTxn] = useState(null);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState(0);
  const [floatMeta, setFloatMeta] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  // PIN modal state
  const [showPinModal, setShowPinModal] = useState(false);
  const [pendingPaise, setPendingPaise] = useState(null); // amount waiting for PIN

  useEffect(() => {
    computeLocalBalance().then(({ balance: b }) => setBalance(b));
    getWalletMeta().then((meta) => setFloatMeta(meta));
  }, []);

  // ── Step 1: Validate amount, then show PIN modal ───────────────────────────
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
        // non-blocking — fall through to PIN
      } else {
        setError(validationResult);
        return;
      }
    }

    // Offline float guard
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

    // Store the validated amount and show the PIN modal
    setPendingPaise(paise);
    setShowPinModal(true);
  }

  // ── Step 2: PIN verified → actually build & record transaction ─────────────
  async function handlePinSuccess() {
    setShowPinModal(false);
    setLoading(true);

    try {
      const keypair = await getKeypair();
      if (!keypair) { setError('No keys found. Please re-register.'); return; }

      let deviceSeq = undefined;
      if (floatMeta?.floatNextSeq !== undefined) {
        deviceSeq = floatMeta.floatNextSeq;
        // NOTE: We update floatNextSeq and floatSpentOffline here optimistically.
        // If the user later cancels, handleCancel() will roll these back.
        await updateWalletMeta({
          floatNextSeq: deviceSeq + 1,
          floatSpentOffline: (floatMeta.floatSpentOffline || 0) + pendingPaise
        });
        // Keep a snapshot so cancel can roll back precisely
        setFloatMeta((prev) => ({
          ...prev,
          floatNextSeq: deviceSeq + 1,
          floatSpentOffline: (prev?.floatSpentOffline || 0) + pendingPaise,
          _preGenerateSeq: deviceSeq,
          _preGenerateSpent: prev?.floatSpentOffline || 0
        }));
      }

      const txn = buildSignedTransaction({
        senderVpa: user.vpa,
        amount: pendingPaise,
        privateKeyB64: keypair.privateKeyB64,
        publicKeyB64: keypair.publicKeyB64,
        deviceId: deviceId || undefined,
        deviceSeq
      });

      // Record as PENDING_SCAN — balance NOT yet affected
      await recordSentTransaction(txn);

      const dataUrl = await generateQRCode(txn);
      setQrDataUrl(dataUrl);
      setSignedTxn(txn);
    } catch (err) {
      setError(`Payment failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  function handlePinCancel() {
    setShowPinModal(false);
    setPendingPaise(null);
  }

  // ── Confirm: receiver scanned → PENDING_SYNC (balance deducted now) ─────────
  async function handleConfirmSent() {
    try {
      await confirmSentTransaction(signedTxn.txnId);
      setConfirmed(true);
      const { balance: newBal } = await computeLocalBalance();
      setBalance(newBal);
    } catch (err) {
      setError(`Failed to confirm: ${err.message}`);
    }
  }

  // ── Cancel: QR not scanned → CANCELLED, balance unchanged ─────────────────
  async function handleCancel() {
    if (signedTxn) await cancelSentTransaction(signedTxn.txnId);

    // Roll back floatSpentOffline and floatNextSeq if they were incremented
    if (floatMeta?._preGenerateSeq !== undefined) {
      await updateWalletMeta({
        floatNextSeq: floatMeta._preGenerateSeq,
        floatSpentOffline: floatMeta._preGenerateSpent
      });
    }

    setQrDataUrl(null);
    setSignedTxn(null);
    setAmountRupees('');
    setError('');
    setWarning('');
    setConfirmed(false);
    setPendingPaise(null);
    // Re-read fresh meta so floatMeta state is correct
    const freshMeta = await getWalletMeta();
    setFloatMeta(freshMeta);
    const { balance: newBal } = await computeLocalBalance();
    setBalance(newBal);
  }

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
      {/* PIN Modal — shown before every payment, verified offline */}
      {showPinModal && (
        <PinModal
          amountDisplay={pendingPaise ? fmt(pendingPaise) : ''}
          onSuccess={handlePinSuccess}
          onCancel={handlePinCancel}
        />
      )}

      <header className="page-header">
        <button
          className="btn-back"
          onClick={signedTxn && !confirmed ? handleCancel : onBack}
          aria-label="Back"
        >←</button>
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
          {loading && <div className="loading-hint">Generating QR…</div>}

          <button type="submit" className="btn-primary" disabled={loading || !amountRupees}>
            {loading ? 'Please wait...' : '🔐 Enter PIN & Generate QR'}
          </button>
        </form>
      )}

      {/* ── Step 2: QR display ── */}
      {qrDataUrl && !confirmed && (
        <div className="qr-display">
          <div className="qr-status-banner pending">
            📱 Show this QR to the recipient — valid for <strong>5 minutes</strong>
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
              <code className="txn-id-full">{signedTxn.txnId}</code>
            </div>
            <div className="summary-row">
              <span>Date &amp; Time</span>
              <span>{new Date(signedTxn.timestamp).toLocaleString()}</span>
            </div>
            <div className="summary-row">
              <span>Status</span>
              <span className="status-tag pending-scan">Waiting for scan…</span>
            </div>
          </div>

          {error && <div className="error-msg" role="alert">{error}</div>}

          {/* Desktop testing: copy raw payment JSON so receiver can paste it */}
          <CopyPaymentData txn={signedTxn} />

          <button className="btn-primary confirm-btn" onClick={handleConfirmSent}>
            ✓ Receiver Scanned — Confirm Payment
          </button>
          <button className="btn-cancel" onClick={handleCancel}>
            ✕ Cancel — Receiver Didn't Scan
          </button>
          <p className="cancel-hint">
            Your balance won't change until you tap "Confirm Payment".
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
              <span>To</span>
              <strong>{signedTxn.receiverVpa || '(receiver VPA pending)'}</strong>
            </div>
            <div className="summary-row">
              <span>Transaction ID</span>
              <code className="txn-id-full">{signedTxn.txnId}</code>
            </div>
            <div className="summary-row">
              <span>Date &amp; Time</span>
              <span>{new Date(signedTxn.timestamp).toLocaleString()}</span>
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
