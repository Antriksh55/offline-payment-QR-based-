/**
 * Send Page — Module 10 UI + Module 3 (QR Generation)
 *
 * Flow:
 *   1. Enter amount → UPI PIN modal
 *   2. PIN verified → build signed transaction, record as PENDING_SCAN (balance unchanged)
 *   3. QR displayed + Copy Payment Data button shown
 *   4. Sender waits — the page POLLS for a receiver acknowledgement every 3 seconds
 *      via localStorage (same browser) and server /api/ack (cross-device)
 *   5. When receiver scans/pastes and accepts:
 *      - Receiver writes ack (localStorage + server)
 *      - Sender's polling detects it → automatically moves to PENDING_SYNC
 *      - Balance deducted, success screen shown — NO manual sender confirmation needed
 *   6. If receiver rejects → shows rejection reason
 *   7. Sender can cancel (before ack) → CANCELLED, balance unchanged
 *
 * The sender can NEVER self-confirm. Only a receiver ack triggers PENDING_SYNC.
 */

import { useState, useEffect, useRef } from 'react';
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
import { checkAck, clearAck } from '../transaction/ackService';
import { Html5Qrcode } from 'html5-qrcode';
import PinModal from '../components/PinModal';
import '../styles/send.css';

const POLL_INTERVAL_MS = 2500;
const ACK_SCANNER_ID = 'ack-qr-scanner';

/** Parse the short ack code: "ACK-[first6ofTxnId]-[receiverVpa]" */
function parseAckCode(code, txnId) {
  try {
    const trimmed = code.trim();
    // Format: ACK-XXXXXX-vpa@bank
    const match = trimmed.match(/^ACK-([A-Za-z0-9]{6})-(.+)$/i);
    if (!match) return null;
    const shortCode = match[1].toUpperCase();
    const receiverVpa = match[2];
    // Verify the short code matches the first 6 chars of the current txnId
    const expectedShort = txnId.replace(/-/g, '').slice(0, 6).toUpperCase();
    if (shortCode !== expectedShort) return null;
    return { txnId, receiverVpa, status: 'accepted' };
  } catch { return null; }
} // poll every 2.5 seconds

/** Copies the raw signed transaction JSON to clipboard */
function CopyPaymentData({ txn }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(txn));
    } catch {
      const ta = document.createElement('textarea');
      ta.value = JSON.stringify(txn);
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
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
  const [showPinModal, setShowPinModal] = useState(false);
  const [pendingPaise, setPendingPaise] = useState(null);
  // ack states
  const [ackStatus, setAckStatus] = useState(null); // null | 'waiting' | 'accepted' | 'rejected'
  const [ackReceiver, setAckReceiver] = useState('');
  const [showAckPaste, setShowAckPaste] = useState(false);
  const [ackPasteText, setAckPasteText] = useState('');
  const [ackPasteError, setAckPasteError] = useState('');
  const [showAckScanner, setShowAckScanner] = useState(false);
  const ackScannerRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => {
    computeLocalBalance().then(({ balance: b }) => setBalance(b));
    getWalletMeta().then((meta) => setFloatMeta(meta));
  }, []);

  // Start polling when QR is shown
  useEffect(() => {
    if (!signedTxn || ackStatus === 'accepted' || ackStatus === 'rejected') return;

    setAckStatus('waiting');

    pollRef.current = setInterval(async () => {
      const ack = await checkAck(signedTxn.txnId, user.token);
      if (!ack) return;

      clearInterval(pollRef.current);

      if (ack.status === 'accepted') {
        // Receiver accepted — automatically confirm on sender side, passing receiver VPA
        await confirmSentTransaction(signedTxn.txnId, ack.receiverVpa);
        const { balance: newBal } = await computeLocalBalance();
        setBalance(newBal);
        setAckReceiver(ack.receiverVpa);
        setAckStatus('accepted');
        clearAck(signedTxn.txnId);
      } else {
        // Receiver rejected
        setAckStatus('rejected');
        setError(ack.reason || 'Payment was declined by the receiver');
        clearAck(signedTxn.txnId);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(pollRef.current);
  }, [signedTxn?.txnId]);

  // ── Step 1: Validate → PIN modal ─────────────────────────────────────────
  async function handleGenerate(e) {
    e.preventDefault();
    setError('');
    setWarning('');
    setQrDataUrl(null);
    setAckStatus(null);

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

    if (floatMeta?.floatReservedAmount && floatMeta?.floatExpiresAt) {
      const expiresAt = new Date(floatMeta.floatExpiresAt);
      const spentSoFar = floatMeta.floatSpentOffline || 0;
      if (new Date() > expiresAt) {
        setError('Your offline spending limit has expired. Reconnect to refresh it.');
        return;
      }
      if (spentSoFar + paise > floatMeta.floatReservedAmount) {
        setError(`Offline spending limit reached (₹${(floatMeta.floatReservedAmount / 100).toFixed(2)} total). Reconnect to refresh.`);
        return;
      }
    }

    setPendingPaise(paise);
    setShowPinModal(true);
  }

  // ── Step 2: PIN verified → build transaction ──────────────────────────────
  async function handlePinSuccess() {
    setShowPinModal(false);
    setLoading(true);

    try {
      const keypair = await getKeypair();
      if (!keypair) { setError('No keys found. Please re-register.'); return; }

      let deviceSeq = undefined;
      if (floatMeta?.floatNextSeq !== undefined) {
        deviceSeq = floatMeta.floatNextSeq;
        await updateWalletMeta({
          floatNextSeq: deviceSeq + 1,
          floatSpentOffline: (floatMeta.floatSpentOffline || 0) + pendingPaise
        });
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

  // ── Paste Ack Code: sender pastes receiver's ack code offline ─────────────
  async function handlePasteAckCode(e) {
    e.preventDefault();
    setAckPasteError('');
    await processAckCode(ackPasteText);
  }

  // ── Cancel: before ack arrives ────────────────────────────────────────────
  async function handleCancel() {
    clearInterval(pollRef.current);
    if (signedTxn) await cancelSentTransaction(signedTxn.txnId);

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
    setAckStatus(null);
    setPendingPaise(null);
    const freshMeta = await getWalletMeta();
    setFloatMeta(freshMeta);
    const { balance: newBal } = await computeLocalBalance();
    setBalance(newBal);
  }

  // ── Scan Ack QR: sender scans the QR shown on receiver's screen ─────────
  async function startAckScanner() {
    setShowAckScanner(true);
    setAckPasteError('');

    // Try cameras in order: rear → front → any
    const cameraCandidates = [
      { facingMode: 'environment' },  // mobile rear
      { facingMode: 'user' },          // laptop webcam / mobile front
    ];

    let started = false;
    for (const cameraConstraint of cameraCandidates) {
      try {
        const scanner = new Html5Qrcode(ACK_SCANNER_ID);
        ackScannerRef.current = scanner;
        await scanner.start(
          cameraConstraint,
          { fps: 10, qrbox: { width: 240, height: 240 } },
          async (decoded) => {
            await scanner.stop().catch(() => {});
            ackScannerRef.current = null;
            setShowAckScanner(false);
            await processAckCode(decoded);
          },
          () => {}
        );
        started = true;
        break; // successfully started
      } catch {
        // try next camera
        if (ackScannerRef.current) {
          ackScannerRef.current.stop().catch(() => {});
          ackScannerRef.current = null;
        }
      }
    }

    if (!started) {
      setShowAckScanner(false);
      setAckPasteError('');
      // Don't show an error — just let them use upload or paste
    }
  }

  // ── Upload ack QR image (laptop / no-camera fallback) ─────────────────────
  async function handleAckFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAckPasteError('');
    try {
      const scannerId = 'ack-file-scanner';
      let div = document.getElementById(scannerId);
      if (!div) {
        div = document.createElement('div');
        div.id = scannerId;
        div.style.display = 'none';
        document.body.appendChild(div);
      }
      const scanner = new Html5Qrcode(scannerId);
      const decoded = await scanner.scanFile(file, true);
      await processAckCode(decoded);
    } catch {
      setAckPasteError('Could not read QR from image. Make sure the image is clear.');
    }
  }

  // ── Shared ack code processor ─────────────────────────────────────────────
  async function processAckCode(code) {
    const parsed = parseAckCode(code, signedTxn?.txnId);
    if (!parsed) {
      setAckPasteError('Invalid ack QR/code. Ask receiver to show their green confirmation screen.');
      return;
    }
    clearInterval(pollRef.current);
    await confirmSentTransaction(signedTxn.txnId, parsed.receiverVpa);
    const { balance: newBal } = await computeLocalBalance();
    setBalance(newBal);
    setAckReceiver(parsed.receiverVpa);
    setAckStatus('accepted');
    clearAck(signedTxn.txnId);
  }

  async function stopAckScanner() {
    if (ackScannerRef.current) {
      try { await ackScannerRef.current.stop(); } catch {}
      ackScannerRef.current = null;
    }
    setShowAckScanner(false);
  }

  // cleanup on unmount
  useEffect(() => {
    return () => {
      if (ackScannerRef.current) {
        ackScannerRef.current.stop().catch(() => {});
      }
    };
  }, []);

  async function handleNewTransaction() {
    clearInterval(pollRef.current);
    setQrDataUrl(null);
    setSignedTxn(null);
    setAmountRupees('');
    setError('');
    setWarning('');
    setAckStatus(null);
    const { balance: newBal } = await computeLocalBalance();
    setBalance(newBal);
  }

  const fmt = (p) => `₹${(p / 100).toFixed(2)}`;
  const isAccepted = ackStatus === 'accepted';
  const isRejected = ackStatus === 'rejected';

  return (
    <div className="send-page">
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
          onClick={signedTxn && !isAccepted ? handleCancel : onBack}
          aria-label="Back"
        >←</button>
        <h2>Send Money</h2>
      </header>

      {/* ── Step 1: Amount entry ── */}
      {!qrDataUrl && (
        <form onSubmit={handleGenerate} className="send-form">
          <div className="balance-hint">Balance: <strong>{fmt(balance)}</strong></div>

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

      {/* ── Step 2: QR waiting for receiver ── */}
      {qrDataUrl && !isAccepted && !isRejected && (
        <div className="qr-display">
          <div className="qr-status-banner pending">
            <span className="ack-pulse">●</span>
            Waiting for receiver to scan — valid for <strong>5 minutes</strong>
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
              <span className="status-tag pending-scan">⏳ Waiting for receiver…</span>
            </div>
          </div>

          <CopyPaymentData txn={signedTxn} />

          {/* ── Ack QR Scanner — most natural cross-device confirmation ── */}
          {!showAckScanner && !showAckPaste && (
            <div className="ack-options">
              <button className="btn-scan-ack" onClick={startAckScanner}>
                📷 Scan Receiver's Confirmation QR
              </button>
              <label className="btn-scan-ack btn-upload-ack">
                🖼️ Upload Photo of Receiver's QR
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={handleAckFileUpload}
                />
              </label>
              <button
                className="btn-paste-ack"
                onClick={() => { setShowAckPaste(true); setAckPasteError(''); }}
              >
                ✏️ Type / Paste Ack Code Instead
              </button>
            </div>
          )}

          {/* Ack QR scanner view */}
          {showAckScanner && (
            <div className="ack-scanner-wrap">
              <p className="ack-scanner-hint">Point camera at receiver's green QR code</p>
              <div id={ACK_SCANNER_ID} className="ack-scanner-container" />
              <button className="btn-secondary" onClick={stopAckScanner}>Cancel</button>
            </div>
          )}

          {/* Paste ack code fallback */}
          {showAckPaste && !showAckScanner && (
            <form onSubmit={handlePasteAckCode} className="ack-paste-form">
              <p className="ack-paste-label">
                Paste the short code shown on receiver's screen (e.g. <code>ACK-A1B2C3-utsav@fakebankb</code>):
              </p>
              <input
                type="text"
                className="ack-paste-input"
                placeholder="ACK-XXXXXX-vpa@bank"
                value={ackPasteText}
                onChange={(e) => setAckPasteText(e.target.value)}
                autoFocus
              />
              {ackPasteError && <div className="error-msg">{ackPasteError}</div>}
              <div className="ack-paste-btns">
                <button type="button" className="btn-link" onClick={() => { setShowAckPaste(false); setAckPasteText(''); }}>← Back</button>
                <button type="submit" className="btn-primary" style={{flex:1}} disabled={!ackPasteText.trim()}>
                  ✓ Confirm
                </button>
              </div>
            </form>
          )}

          {ackPasteError && !showAckPaste && <div className="error-msg">{ackPasteError}</div>}

          <div className="ack-waiting-note">
            Ask the receiver to show their <strong>green confirmation QR</strong> — scan it to confirm instantly. Works offline.
          </div>

          <button className="btn-cancel" onClick={handleCancel}>✕ Cancel Payment</button>
        </div>
      )}

      {/* ── Step 3a: Receiver accepted ── */}
      {isAccepted && (
        <div className="qr-display">
          <div className="qr-status-banner success">
            ✅ Receiver accepted the payment — syncing when online
          </div>

          <div className="txn-summary">
            <div className="summary-row">
              <span>Amount sent</span>
              <strong className="amount-sent">{fmt(signedTxn.amount)}</strong>
            </div>
            <div className="summary-row">
              <span>To</span>
              <strong>{ackReceiver}</strong>
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
              <span className="status-tag pending-sync">🔄 Pending Sync</span>
            </div>
          </div>

          <button className="btn-secondary" onClick={handleNewTransaction}>Send Another</button>
          <button className="btn-link" onClick={onBack}>Back to Dashboard</button>
        </div>
      )}

      {/* ── Step 3b: Receiver rejected ── */}
      {isRejected && (
        <div className="qr-display">
          <div className="qr-status-banner" style={{background:'#fff0f0', color:'#d63031', border:'1px solid #ffb3b3'}}>
            ❌ Payment declined by receiver
          </div>
          {error && <div className="error-msg" role="alert">{error}</div>}
          <button className="btn-secondary" onClick={handleNewTransaction}>Try Again</button>
          <button className="btn-link" onClick={onBack}>Back to Dashboard</button>
        </div>
      )}
    </div>
  );
}
