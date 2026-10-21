/**
 * Receive Page — Module 10 UI + Module 3 (QR Scanning) + Module 4 (local verification)
 *
 * TWO ways to receive payment (desktop-friendly):
 * 1. Camera scan — use on mobile devices
 * 2. Paste payment data — for desktop testing with two browser tabs
 *    (sender copies the payment data from Send page, receiver pastes it here)
 */

import { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { receiveScannedTransaction } from '../ledger/localLedger';
import { writeAck } from '../transaction/ackService';
import '../styles/receive.css';

const SCANNER_ID = 'qr-scanner-container';

const SCAN_STATE = {
  IDLE: 'idle',
  SCANNING: 'scanning',
  PASTE: 'paste',
  SUCCESS: 'success',
  ERROR: 'error'
};

export default function ReceivePage({ user, onBack }) {
  const [scanState, setScanState] = useState(SCAN_STATE.IDLE);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [processing, setProcessing] = useState(false);
  const scannerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
        scannerRef.current = null;
      }
    };
  }, []);

  // ── Camera scanner ────────────────────────────────────────────────────────
  async function startScanner() {
    setScanState(SCAN_STATE.SCANNING);
    setError('');
    setResult(null);

    try {
      const scanner = new Html5Qrcode(SCANNER_ID);
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 280, height: 280 } },
        async (decodedText) => {
          await scanner.stop();
          scannerRef.current = null;
          await handleScannedPayload(decodedText);
        },
        () => {} // per-frame failures are normal
      );
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.message?.includes('permission')) {
        setError('Camera permission denied. Use "Paste Payment Data" instead for desktop testing.');
      } else if (err.message?.includes('No cameras') || err.message?.includes('no camera')) {
        setError('No camera found. Use "Paste Payment Data" instead.');
      } else {
        setError(`Camera error: ${err.message}. Try "Paste Payment Data" instead.`);
      }
      setScanState(SCAN_STATE.IDLE);
    }
  }

  async function stopScanner() {
    if (scannerRef.current) {
      try { await scannerRef.current.stop(); } catch {}
      scannerRef.current = null;
    }
    setScanState(SCAN_STATE.IDLE);
  }

  // ── Paste handler ─────────────────────────────────────────────────────────
  async function handlePasteSubmit(e) {
    e.preventDefault();
    if (!pasteText.trim()) return;
    setProcessing(true);
    await handleScannedPayload(pasteText.trim());
    setProcessing(false);
  }

  // ── Core payload processor (shared by camera + paste) ────────────────────
  async function handleScannedPayload(rawText) {
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      setError('Invalid payment data — not valid JSON. Copy the full payment data from the sender\'s screen.');
      setScanState(SCAN_STATE.ERROR);
      return;
    }

    const required = ['txnId', 'senderVpa', 'amount', 'timestamp', 'nonce', 'signature', 'senderPublicKey'];
    const missing = required.filter((f) => payload[f] === undefined || payload[f] === null);
    if (missing.length > 0) {
      setError(`Invalid payment code — missing fields: ${missing.join(', ')}`);
      setScanState(SCAN_STATE.ERROR);
      return;
    }

    if (payload.senderVpa === user.vpa) {
      setError('You cannot pay yourself. This is your own payment code.');
      setScanState(SCAN_STATE.ERROR);
      return;
    }

    const enrichedPayload = { ...payload, receiverVpa: user.vpa };

    try {
      const { success, error: verifyError } = await receiveScannedTransaction(enrichedPayload);
      if (!success) {
        // Write a rejected ack so sender knows
        await writeAck(enrichedPayload.txnId, user.vpa, 'rejected', verifyError, user.token);
        setError(verifyError || 'Transaction verification failed');
        setScanState(SCAN_STATE.ERROR);
        return;
      }
      // Write accepted ack — this is what moves the sender's PENDING_SCAN → PENDING_SYNC
      await writeAck(enrichedPayload.txnId, user.vpa, 'accepted', '', user.token);
      setResult(enrichedPayload);
      setScanState(SCAN_STATE.SUCCESS);
    } catch (err) {
      setError(`Failed to record transaction: ${err.message}`);
      setScanState(SCAN_STATE.ERROR);
    }
  }

  const fmt = (p) => `₹${(p / 100).toFixed(2)}`;

  return (
    <div className="receive-page">
      <header className="page-header">
        <button className="btn-back" onClick={onBack} aria-label="Back">←</button>
        <h2>Receive Payment</h2>
      </header>

      {/* ── IDLE: choose method ── */}
      {scanState === SCAN_STATE.IDLE && (
        <div className="scan-idle">
          <div className="scan-icon">💸</div>
          <h3 style={{margin:'0 0 6px'}}>How do you want to receive?</h3>
          <p style={{color:'#636e72', fontSize:'0.88rem', textAlign:'center', marginBottom:'24px'}}>
            On mobile: scan the QR code. On desktop: ask the sender to copy payment data and paste it here.
          </p>

          <button className="btn-primary" onClick={startScanner}>
            📷 Scan QR Code (Mobile)
          </button>

          <div className="or-divider">
            <span>or</span>
          </div>

          <button className="btn-secondary" onClick={() => { setScanState(SCAN_STATE.PASTE); setError(''); }}>
            📋 Paste Payment Data (Desktop)
          </button>

          {error && <div className="error-msg" role="alert" style={{marginTop:'16px'}}>{error}</div>}
        </div>
      )}

      {/* ── SCANNING ── */}
      {scanState === SCAN_STATE.SCANNING && (
        <div className="scan-active">
          <p className="scan-hint">Point your camera at the payment QR code</p>
          <div id={SCANNER_ID} className="scanner-container" />
          <button className="btn-secondary" onClick={stopScanner}>Cancel</button>
        </div>
      )}

      {/* ── PASTE mode ── */}
      {scanState === SCAN_STATE.PASTE && (
        <div className="paste-mode">
          <div className="paste-instructions">
            <h3>Paste Payment Data</h3>
            <ol>
              <li>On the <strong>sender's tab</strong>, go to Send → enter amount → enter PIN → QR appears</li>
              <li>Click <strong>"Copy Payment Data"</strong> button below the QR</li>
              <li>Come back here and paste it in the box below</li>
            </ol>
          </div>

          <form onSubmit={handlePasteSubmit} className="paste-form">
            <textarea
              className="paste-textarea"
              placeholder='Paste payment data here (starts with {"txnId":"...")}'
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={6}
              aria-label="Payment data"
            />

            {error && <div className="error-msg" role="alert">{error}</div>}

            <button
              type="submit"
              className="btn-primary"
              disabled={!pasteText.trim() || processing}
            >
              {processing ? 'Verifying...' : '✓ Verify & Accept Payment'}
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => { setScanState(SCAN_STATE.IDLE); setPasteText(''); setError(''); }}
            >
              ← Back
            </button>
          </form>
        </div>
      )}

      {/* ── SUCCESS ── */}
      {scanState === SCAN_STATE.SUCCESS && result && (
        <div className="scan-result success">
          <div className="result-icon">✅</div>
          <h3>Payment Received!</h3>
          <p className="result-hint">Saved locally. Tap Sync to confirm on the server.</p>

          <div className="result-card">
            <div className="result-row">
              <span>Amount</span>
              <strong className="amount-received">{fmt(result.amount)}</strong>
            </div>
            <div className="result-row">
              <span>From</span>
              <strong>{result.senderVpa}</strong>
            </div>
            <div className="result-row">
              <span>To</span>
              <strong>{result.receiverVpa}</strong>
            </div>
            <div className="result-row">
              <span>Transaction ID</span>
              <code style={{fontSize:'0.72rem', wordBreak:'break-all'}}>{result.txnId}</code>
            </div>
          </div>

          <button className="btn-primary" onClick={() => { setScanState(SCAN_STATE.IDLE); setResult(null); setPasteText(''); }}>
            Receive Another
          </button>
          <button className="btn-link" onClick={onBack}>Back to Dashboard</button>
        </div>
      )}

      {/* ── ERROR ── */}
      {scanState === SCAN_STATE.ERROR && (
        <div className="scan-result error">
          <div className="result-icon">❌</div>
          <h3>Payment Failed</h3>
          <p className="error-detail" role="alert">{error}</p>
          <button className="btn-primary" onClick={() => { setScanState(SCAN_STATE.IDLE); setError(''); setPasteText(''); }}>
            Try Again
          </button>
          <button className="btn-link" onClick={onBack}>Back to Dashboard</button>
        </div>
      )}
    </div>
  );
}
