/**
 * Receive Page — Module 10 UI + Module 3 (QR Scanning) + Module 4 (local verification)
 *
 * Camera-based QR scanning via html5-qrcode.
 * Verifies signature, checks nonce, writes to local ledger.
 */

import { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { receiveScannedTransaction } from '../ledger/localLedger';
import '../styles/receive.css';

const SCANNER_ID = 'qr-scanner-container';

const SCAN_STATE = {
  IDLE: 'idle',
  SCANNING: 'scanning',
  SUCCESS: 'success',
  ERROR: 'error'
};

export default function ReceivePage({ user, onBack }) {
  const [scanState, setScanState] = useState(SCAN_STATE.IDLE);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const scannerRef = useRef(null);

  // Clean up scanner on unmount
  useEffect(() => {
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
        scannerRef.current = null;
      }
    };
  }, []);

  async function startScanner() {
    setScanState(SCAN_STATE.SCANNING);
    setError('');
    setResult(null);

    try {
      const scanner = new Html5Qrcode(SCANNER_ID);
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: 'environment' }, // rear camera preferred
        { fps: 10, qrbox: { width: 280, height: 280 } },
        async (decodedText) => {
          // QR successfully decoded
          await scanner.stop();
          scannerRef.current = null;
          await handleScannedPayload(decodedText);
        },
        (errorMessage) => {
          // Per-frame scan failure — normal, don't surface to user
        }
      );
    } catch (err) {
      // Camera permission denied or unavailable
      if (err.name === 'NotAllowedError' || err.message?.includes('permission')) {
        setError('Camera permission denied. Please allow camera access and try again.');
      } else if (err.message?.includes('No cameras')) {
        setError('No camera found on this device.');
      } else {
        setError(`Could not start camera: ${err.message}`);
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

  async function handleScannedPayload(rawText) {
    // Parse JSON — reject if invalid
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      setError('Invalid or corrupted payment code. Please ask the sender to regenerate.');
      setScanState(SCAN_STATE.ERROR);
      return;
    }

    // Check required fields
    const required = ['txnId', 'senderVpa', 'amount', 'timestamp', 'nonce', 'signature', 'senderPublicKey'];
    const missing = required.filter((f) => payload[f] === undefined || payload[f] === null);
    if (missing.length > 0) {
      setError(`Invalid payment code — missing fields: ${missing.join(', ')}`);
      setScanState(SCAN_STATE.ERROR);
      return;
    }

    // Reject self-payment
    if (payload.senderVpa === user.vpa) {
      setError('You cannot pay yourself. This is your own QR code.');
      setScanState(SCAN_STATE.ERROR);
      return;
    }

    // Set receiverVpa to the current user's VPA before verification
    const enrichedPayload = { ...payload, receiverVpa: user.vpa };

    // Verify + record in local ledger (Module 4)
    try {
      const { success, error: verifyError } = await receiveScannedTransaction(enrichedPayload);

      if (!success) {
        setError(verifyError || 'Transaction verification failed');
        setScanState(SCAN_STATE.ERROR);
        return;
      }

      setResult(enrichedPayload);
      setScanState(SCAN_STATE.SUCCESS);
    } catch (err) {
      setError(`Failed to record transaction: ${err.message}`);
      setScanState(SCAN_STATE.ERROR);
    }
  }

  const formatAmount = (p) => `₹${(p / 100).toFixed(2)}`;

  return (
    <div className="receive-page">
      <header className="page-header">
        <button className="btn-back" onClick={onBack} aria-label="Back">←</button>
        <h2>Scan to Receive</h2>
      </header>

      {/* Idle state */}
      {scanState === SCAN_STATE.IDLE && (
        <div className="scan-idle">
          <div className="scan-icon">📷</div>
          <p>Scan the sender's QR code to receive a payment.</p>
          <button className="btn-primary" onClick={startScanner}>
            Open Camera
          </button>
        </div>
      )}

      {/* Scanning state */}
      {scanState === SCAN_STATE.SCANNING && (
        <div className="scan-active">
          <p className="scan-hint">Point your camera at the payment QR code</p>
          {/* html5-qrcode renders into this container */}
          <div id={SCANNER_ID} className="scanner-container" />
          <button className="btn-secondary" onClick={stopScanner}>
            Cancel
          </button>
        </div>
      )}

      {/* Success state */}
      {scanState === SCAN_STATE.SUCCESS && result && (
        <div className="scan-result success">
          <div className="result-icon">✅</div>
          <h3>Payment Received!</h3>
          <p className="result-hint">Saved locally. Sync to confirm on the server.</p>

          <div className="result-card">
            <div className="result-row">
              <span>Amount</span>
              <strong className="amount-received">{formatAmount(result.amount)}</strong>
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
              <code>{result.txnId.slice(0, 12)}…</code>
            </div>
          </div>

          <button className="btn-primary" onClick={() => { setScanState(SCAN_STATE.IDLE); setResult(null); }}>
            Scan Another
          </button>
          <button className="btn-link" onClick={onBack}>
            Back to Dashboard
          </button>
        </div>
      )}

      {/* Error state */}
      {scanState === SCAN_STATE.ERROR && (
        <div className="scan-result error">
          <div className="result-icon">❌</div>
          <h3>Scan Failed</h3>
          <p className="error-detail" role="alert">{error}</p>
          <button className="btn-primary" onClick={() => { setScanState(SCAN_STATE.IDLE); setError(''); }}>
            Try Again
          </button>
          <button className="btn-link" onClick={onBack}>
            Back to Dashboard
          </button>
        </div>
      )}

      {/* Camera error on scanning state */}
      {scanState === SCAN_STATE.SCANNING && error && (
        <div className="error-msg" role="alert">{error}</div>
      )}
    </div>
  );
}
