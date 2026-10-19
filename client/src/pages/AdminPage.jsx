/**
 * Admin Panel — Module 10 UI + Module 9 (Settlement)
 *
 * Settlement trigger button, settlement batch log,
 * and ledger invariant checker.
 */

import { useState, useEffect } from 'react';
import { api } from '../api/client';
import '../styles/admin.css';

export default function AdminPage({ user, onBack }) {
  const [batches, setBatches] = useState([]);
  const [settling, setSettling] = useState(false);
  const [settleResult, setSettleResult] = useState(null);
  const [settleError, setSettleError] = useState('');
  const [ledgerCheck, setLedgerCheck] = useState(null);
  const [checkingLedger, setCheckingLedger] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchBatches();
  }, []);

  async function fetchBatches() {
    setLoading(true);
    try {
      const data = await api.getSettlementBatches();
      setBatches(data.batches || []);
    } catch (err) {
      console.error('Failed to load batches:', err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRunSettlement() {
    setSettling(true);
    setSettleResult(null);
    setSettleError('');
    try {
      const result = await api.runSettlement();
      setSettleResult(result);
      await fetchBatches();
    } catch (err) {
      setSettleError(err.message);
    } finally {
      setSettling(false);
    }
  }

  async function handleLedgerCheck() {
    setCheckingLedger(true);
    setLedgerCheck(null);
    try {
      const result = await api.getLedgerCheck();
      setLedgerCheck(result);
    } catch (err) {
      setLedgerCheck({ balanced: false, message: 'Failed: ' + err.message });
    } finally {
      setCheckingLedger(false);
    }
  }

  const formatAmount = (p) => `₹${(Math.abs(p) / 100).toFixed(2)}`;
  const formatDate = (d) => new Date(d).toLocaleString();

  return (
    <div className="admin-page">
      <header className="page-header">
        <button className="btn-back" onClick={onBack} aria-label="Back">←</button>
        <h2>Admin Panel</h2>
      </header>

      {/* Settlement Section */}
      <section className="admin-section">
        <h3>Interbank Settlement</h3>
        <p className="section-hint">
          Nets out pending transactions between banks and marks them as settled.
          Simulates NEFT/RTGS batch settlement.
        </p>

        <button className="btn-primary" onClick={handleRunSettlement} disabled={settling}>
          {settling ? 'Running Settlement...' : '▶ Run Settlement Now'}
        </button>

        {settleResult && (
          <div className="settle-result success" role="status">
            <strong>Settlement complete</strong>
            <ul>
              <li>Batches created: {settleResult.batchesCreated}</li>
              <li>Transactions settled: {settleResult.transactionsSettled}</li>
            </ul>
          </div>
        )}

        {settleError && (
          <div className="settle-result error" role="alert">
            Settlement failed: {settleError}
          </div>
        )}
      </section>

      {/* Ledger Invariant Check */}
      <section className="admin-section">
        <h3>Ledger Invariant Check</h3>
        <p className="section-hint">
          Verifies SUM(all DEBITs) = SUM(all CREDITs) across the entire ledger.
          This is the most important correctness check in the system.
        </p>

        <button className="btn-secondary" onClick={handleLedgerCheck} disabled={checkingLedger}>
          {checkingLedger ? 'Checking...' : '🔍 Check Ledger Balance'}
        </button>

        {ledgerCheck && (
          <div className={`ledger-check-result ${ledgerCheck.balanced ? 'success' : 'error'}`} role="status">
            <p>{ledgerCheck.message}</p>
            {!ledgerCheck.balanced && (
              <ul>
                <li>Total DEBITs: {formatAmount(ledgerCheck.debitTotal)}</li>
                <li>Total CREDITs: {formatAmount(ledgerCheck.creditTotal)}</li>
              </ul>
            )}
          </div>
        )}
      </section>

      {/* Settlement Batch Log */}
      <section className="admin-section">
        <h3>Settlement Batch Log</h3>

        {loading ? (
          <p>Loading...</p>
        ) : batches.length === 0 ? (
          <p className="empty-state">No settlement batches yet.</p>
        ) : (
          <div className="batch-list">
            {batches.map((batch, i) => (
              <div key={batch._id || i} className="batch-item">
                <div className="batch-header">
                  <span className="batch-date">{formatDate(batch.runAt)}</span>
                  <span className={`batch-amount ${batch.netAmount >= 0 ? 'positive' : 'negative'}`}>
                    Net: {batch.netAmount >= 0 ? '' : '-'}{formatAmount(batch.netAmount)}
                  </span>
                </div>
                <div className="batch-detail">
                  <span>Banks: </span>
                  {(batch.bankPair || []).map((b, idx) => (
                    <span key={idx} className="bank-tag">{b.name || b.code || b}</span>
                  ))}
                </div>
                <div className="batch-txn-count">
                  {batch.txnIds?.length || 0} transaction(s)
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
