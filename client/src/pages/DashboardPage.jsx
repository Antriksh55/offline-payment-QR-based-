/**
 * Wallet / Dashboard Page — Module 10 UI
 *
 * Shows balance, transaction history with status tags,
 * sync button, and navigation to Send/Receive.
 */

import { useState, useEffect, useCallback } from 'react';
import { computeLocalBalance, getAllLocalTransactions, TXN_STATUS } from '../ledger/localLedger';
import { syncPendingTransactions } from '../sync/syncService';
import { api } from '../api/client';
import '../styles/dashboard.css';

const STATUS_LABELS = {
  [TXN_STATUS.PENDING_SCAN]: { label: 'Awaiting Scan', className: 'status-awaiting' },
  [TXN_STATUS.PENDING_SYNC]: { label: 'Pending Sync', className: 'status-pending' },
  [TXN_STATUS.CONFIRMED]: { label: 'Confirmed', className: 'status-confirmed' },
  [TXN_STATUS.REJECTED_DOUBLE_SPEND]: { label: 'Rejected (Double Spend)', className: 'status-rejected' },
  [TXN_STATUS.REJECTED]: { label: 'Rejected', className: 'status-rejected' },
  [TXN_STATUS.CANCELLED]: { label: 'Cancelled', className: 'status-cancelled' }
};

export default function DashboardPage({ user, onNavigate, onLogout, deviceId }) {
  const [balance, setBalance] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [transactions, setTransactions] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);
  const [syncError, setSyncError] = useState(null);
  const [serverBalance, setServerBalance] = useState(null);

  const refreshBalance = useCallback(async () => {
    try {
      const { balance: bal, pendingCount: pc } = await computeLocalBalance();
      setBalance(bal);
      setPendingCount(pc);
    } catch (err) {
      console.error('Balance computation error:', err);
    }
  }, []);

  const refreshTransactions = useCallback(async () => {
    try {
      const txns = await getAllLocalTransactions();
      setTransactions(txns);
    } catch (err) {
      console.error('Transaction list error:', err);
    }
  }, []);

  useEffect(() => {
    refreshBalance();
    refreshTransactions();
  }, [refreshBalance, refreshTransactions]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    setSyncError(null);

    try {
      const result = await syncPendingTransactions(user.token, user.vpa, deviceId);

      if (result.synced === 0) {
        setSyncMessage('Everything is up to date — no pending transactions.');
      } else {
        const confirmed = result.results.filter((r) => r.respCode === '00').length;
        const rejected = result.results.filter((r) => r.respCode !== '00').length;
        setSyncMessage(
          `Synced ${result.synced} transaction(s): ${confirmed} confirmed, ${rejected} rejected.`
        );
        if (result.newBalance !== null) {
          setServerBalance(result.newBalance);
        }
      }

      // Refresh UI after sync updates statuses
      await refreshBalance();
      await refreshTransactions();
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const formatAmount = (paise) => `₹${(paise / 100).toFixed(2)}`;
  const formatTime = (ms) => new Date(ms).toLocaleString();

  return (
    <div className="dashboard">
      {/* Header */}
      <header className="dashboard-header">
        <div className="header-user">
          <span className="user-avatar">{user.displayName?.[0]?.toUpperCase() || '?'}</span>
          <div>
            <div className="user-name">{user.displayName}</div>
            <div className="user-vpa">{user.vpa}</div>
          </div>
        </div>
        <button className="btn-icon" onClick={onLogout} aria-label="Logout" title="Logout">
          ⏻
        </button>
      </header>

      {/* Balance Card */}
      <div className="balance-card">
        <div className="balance-label">Available Balance</div>
        <div className="balance-amount">{formatAmount(balance)}</div>
        {pendingCount > 0 && (
          <div className="balance-pending">
            {pendingCount} pending transaction{pendingCount > 1 ? 's' : ''}
          </div>
        )}
        {serverBalance !== null && (
          <div className="balance-server">
            Server-confirmed: {formatAmount(serverBalance)}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="action-buttons">
        <button className="action-btn send" onClick={() => onNavigate('send')}>
          <span className="action-icon">↑</span>
          <span>Send</span>
        </button>
        <button className="action-btn receive" onClick={() => onNavigate('receive')}>
          <span className="action-icon">↓</span>
          <span>Receive</span>
        </button>
        <button className="action-btn sync" onClick={handleSync} disabled={syncing}>
          <span className="action-icon">{syncing ? '⟳' : '↻'}</span>
          <span>{syncing ? 'Syncing...' : 'Sync'}</span>
        </button>
      </div>

      {/* Sync Result Messages */}
      {syncMessage && (
        <div className="sync-message success" role="status">{syncMessage}</div>
      )}
      {syncError && (
        <div className="sync-message error" role="alert">
          Sync failed: {syncError}
        </div>
      )}

      {/* Transaction History */}
      <section className="transaction-list">
        <h3>Transactions</h3>

        {transactions.length === 0 ? (
          <div className="empty-state">
            No transactions yet. Send or receive to get started.
          </div>
        ) : (
          transactions.map((txn) => {
            const isSent = txn.direction === 'sent';
            const statusInfo = STATUS_LABELS[txn.status] || { label: txn.status, className: '' };
            const isDoubleSpend = txn.status === TXN_STATUS.REJECTED_DOUBLE_SPEND;
            const isCancelled = txn.status === TXN_STATUS.CANCELLED;
            const isPendingScan = txn.status === TXN_STATUS.PENDING_SCAN;
            // Don't show a debit for cancelled or awaiting-scan entries — no money moved
            const showAmount = !isCancelled && !isPendingScan;

            return (
              <div
                key={txn.txnId}
                className={`txn-item ${isSent ? 'sent' : 'received'} ${isDoubleSpend ? 'double-spend' : ''} ${isCancelled ? 'cancelled' : ''}`}
              >
                <div className="txn-direction">
                  <span className="txn-arrow">{isSent ? '↑' : '↓'}</span>
                  <div>
                    <div className="txn-party">{txn.counterpartyVpa}</div>
                    <div className="txn-time">{formatTime(txn.timestamp)}</div>
                  </div>
                </div>
                <div className="txn-right">
                  <div className={`txn-amount ${isSent ? 'amount-sent' : 'amount-received'} ${!showAmount ? 'amount-void' : ''}`}>
                    {showAmount
                      ? `${isSent ? '-' : '+'}${formatAmount(txn.amount)}`
                      : '—'}
                  </div>
                  <div className={`txn-status ${statusInfo.className}`}>
                    {statusInfo.label}
                  </div>
                </div>
                {isDoubleSpend && (
                  <div className="double-spend-warning" role="alert">
                    ⚠️ This transaction was rejected during sync — insufficient balance at the time of settlement. The recipient did not receive these funds.
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
