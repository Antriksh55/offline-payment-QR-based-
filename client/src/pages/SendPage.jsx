/**
 * Send Page — Module 10 UI + Module 3 (QR Generation)
 *
 * Amount entry → generates signed QR code for the receiver to scan.
 * All amounts in paise. Validates before signing.
 */

import { useState, useEffect } from 'react';
import { buildSignedTransaction, validateAmount } from '../transaction/builder';
import { generateQRCode } from '../qr/qrGenerator';
import { recordSentTransaction, computeLocalBalance, getWalletMeta, updateWalletMeta } from '../ledger/localLedger';
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

  useEffect(() => {
    computeLocalBalance().then(({ balance: b }) => setBalance(b));
    getWalletMeta().then((meta) => setFloatMeta(meta));
  }, []);

  async function handleGenerate(e) {
    e.preventDefault();
    setError('');
    setWarning('');
    setQrDataUrl(null);

    // Convert rupees input to paise (integer)
    const paise = Math.round(parseFloat(amountRupees) * 100);
    if (isNaN(paise)) {
      setError('Please enter a valid amount');
      return;
    }

    // Validate amount
    const validationResult = validateAmount(paise, balance);
    if (validationResult) {
      if (validationResult.startsWith('__WARN__:')) {
        setWarning(validationResult.replace('__WARN__:', ''));
        // Do not block — server-side will catch any double-spend
      } else {
        setError(validationResult);
        return;
      }
    }

    // Offline float guard (client-side UX, not the real security boundary)
    if (floatMeta?.floatReservedAmount && floatMeta?.floatExpiresAt) {
      const expiresAt = new Date(floatMeta.floatExpiresAt);
      const spentSoFar = floatMeta.floatSpentOffline || 0;
      if (new Date() > expiresAt) {
        setError('Your offline spending limit has expired. Please reconnect to refresh it.');
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
      if (!keypair) {
        setError('No keys found. Please re-register.');
        return;
      }

      // Determine deviceSeq for float-backed transactions
      let deviceSeq = undefined;
      if (floatMeta?.floatNextSeq !== undefined) {
        deviceSeq = floatMeta.floatNextSeq;
        // Increment nextSeq in meta for the next transaction
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

      // Record locally before showing QR
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

  function handleReset() {
    setQrDataUrl(null);
    setSignedTxn(null);
    setAmountRupees('');
    setError('');
    setWarning('');
  }

  const formatBalance = (p) => `₹${(p / 100).toFixed(2)}`;

  return (
    <div className="send-page">
      <header className="page-header">
        <button className="btn-back" onClick={onBack} aria-label="Back">←</button>
        <h2>Send Money</h2>
      </header>

      {!qrDataUrl ? (
        <form onSubmit={handleGenerate} className="send-form">
          <div className="balance-hint">
            Balance: <strong>{formatBalance(balance)}</strong>
          </div>

          {floatMeta?.floatReservedAmount && (
            <div className="float-info">
              Offline limit: {formatBalance(floatMeta.floatReservedAmount - (floatMeta.floatSpentOffline || 0))} remaining
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

          {warning && (
            <div className="warning-msg" role="alert">
              ⚠️ {warning}
            </div>
          )}
          {error && (
            <div className="error-msg" role="alert">{error}</div>
          )}

          <button type="submit" className="btn-primary" disabled={loading || !amountRupees}>
            {loading ? 'Generating QR...' : 'Generate QR Code'}
          </button>
        </form>
      ) : (
        <div className="qr-display">
          <p className="qr-instructions">
            Show this QR code to the recipient. It is valid for <strong>5 minutes</strong>.
          </p>

          <div className="qr-container">
            <img
              src={qrDataUrl}
              alt="Payment QR Code"
              className="qr-image"
            />
          </div>

          <div className="txn-summary">
            <div className="summary-row">
              <span>Amount</span>
              <strong>{formatBalance(signedTxn.amount)}</strong>
            </div>
            <div className="summary-row">
              <span>From</span>
              <strong>{signedTxn.senderVpa}</strong>
            </div>
            <div className="summary-row">
              <span>Transaction ID</span>
              <code className="txn-id">{signedTxn.txnId.slice(0, 8)}…</code>
            </div>
          </div>

          <button className="btn-secondary" onClick={handleReset}>
            New Transaction
          </button>
          <button className="btn-link" onClick={onBack}>
            Back to Dashboard
          </button>
        </div>
      )}
    </div>
  );
}
