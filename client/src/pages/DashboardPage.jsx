/**
 * Wallet / Dashboard Page — Module 10 UI
 *
 * Shows balance, transaction history (txnId, date/time, status pill),
 * sync button, online/offline indicator, and reconciliation status.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { computeLocalBalance, getAllLocalTransactions, TXN_STATUS, updateWalletMeta, confirmSentTransaction, cancelSentTransaction } from '../ledger/localLedger';
import { syncPendingTransactions } from '../sync/syncService';
import { checkAck, clearAck } from '../transaction/ackService';
import '../styles/dashboard.css';

const STATUS_LABELS = {
  [TXN_STATUS.PENDING_SCAN]: { label: 'QR Not Scanned', className: 'status-awaiting', icon: '⏳' },
  [TXN_STATUS.PENDING_SYNC]: { label: 'Pending Sync',   className: 'status-pending',  icon: '🔄' },
  [TXN_STATUS.CONFIRMED]:    { label: 'Success',         className: 'status-confirmed', icon: '✅' },
  [TXN_STATUS.REJECTED_DOUBLE_SPEND]: { label: 'Failed', className: 'status-rejected', icon: '❌' },
  [TXN_STATUS.REJECTED]:     { label: 'Rejected',        className: 'status-rejected', icon: '❌' },
  [TXN_STATUS.CANCELLED]:    { label: 'Cancelled',       className: 'status-cancelled', icon: '🚫' }
};

/** Format timestamp → "19 Oct 2026, 4:30 PM" */
function formatDateTime(ms) {
  return new Date(ms).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

/** Truncate UUID for display: "a1b2c3d4…e5f6" */
function shortId(txnId = '') {
  if (txnId.length <= 13) return txnId;
  return `${txnId.slice(0, 8)}…${txnId.slice(-4)}`;
}

export default function DashboardPage({ user, onNavigate, onLogout, deviceId }) {
  const [balance, setBalance] = useState(null); // null = loading, not yet computed
  const [pendingCount, setPendingCount] = useState(0);
  const [transactions, setTransactions] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);
  const [syncError, setSyncError] = useState(null);
  const [serverBalance, setServerBalance] = useState(null);
  // null = checking, true = online, false = offline
  const [isOnline, setIsOnline] = useState(null);
  const [expandedTxn, setExpandedTxn] = useState(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [cancellingTxn, setCancellingTxn] = useState(null);

  // ── Real connectivity check ─────────────────────────────────────────────
  // navigator.onLine is unreliable (reports OS network, not actual server reachability).
  // We ping GET /api/health and check the response instead.
  // Runs on mount and every 10 seconds. Switches to fast 3s retry when offline.
  const connectivityRef = useRef(null);

  const checkConnectivity = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout
      const res = await fetch('/api/health', {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store'
      });
      clearTimeout(timeout);
      setIsOnline(res.ok);
    } catch {
      setIsOnline(false);
    }
  }, []);

  useEffect(() => {
    // Check immediately on mount
    checkConnectivity();

    // Then poll — 10s when online, 5s when offline for faster recovery detection
    const schedule = () => {
      connectivityRef.current = setTimeout(async () => {
        await checkConnectivity();
        schedule();
      }, isOnline === false ? 5000 : 10000);
    };
    schedule();

    return () => clearTimeout(connectivityRef.current);
  }, [isOnline, checkConnectivity]);

  const refreshBalance = useCallback(async () => {
    setBalanceLoading(true);
    try {
      // Always try to get authoritative server balance first to seed lastSyncedBalance.
      // This is the definitive fix for ₹NaN — it ensures the seed balance (₹5000)
      // is written to IndexedDB BEFORE computeLocalBalance() reads it.
      if (user?.token && user?.vpa) {
        try {
          const res = await fetch(`/api/balance/${encodeURIComponent(user.vpa)}`, {
            headers: { Authorization: `Bearer ${user.token}` }
          });
          if (res.ok) {
            const data = await res.json();
            // Use `balance` (credits-debits), NOT `available` (balance-holds)
            const serverBal = typeof data.balance === 'number' ? data.balance : data.available;
            if (typeof serverBal === 'number') {
              await updateWalletMeta({ lastSyncedBalance: serverBal });
            }
          }
        } catch {
          // Offline — fall through to local computation with cached lastSyncedBalance
        }
      }

      const { balance: bal, pendingCount: pc } = await computeLocalBalance();
      setBalance(bal);
      setPendingCount(pc);
    } catch (err) {
      console.error('Balance error:', err);
      setBalance(0);
    } finally {
      setBalanceLoading(false);
    }
  }, [user?.token, user?.vpa]);

  const refreshTransactions = useCallback(async () => {
    try {
      const txns = await getAllLocalTransactions();

      // For any PENDING_SCAN sent transaction, check if an ack has arrived.
      // This handles the case where the ack came in while the user was away
      // from the SendPage (polling stopped) — we catch it here on dashboard load.
      const pendingScanSent = txns.filter(
        (t) => t.direction === 'sent' && t.status === TXN_STATUS.PENDING_SCAN
      );

      let needsRefresh = false;
      for (const txn of pendingScanSent) {
        const ack = await checkAck(txn.txnId, user?.token || '');
        if (ack?.status === 'accepted') {
          await confirmSentTransaction(txn.txnId, ack.receiverVpa);
          clearAck(txn.txnId);
          needsRefresh = true;
        } else if (ack?.status === 'rejected') {
          await cancelSentTransaction(txn.txnId);
          clearAck(txn.txnId);
          needsRefresh = true;
        }
      }

      // Re-fetch if any statuses changed
      const finalTxns = needsRefresh ? await getAllLocalTransactions() : txns;
      setTransactions(finalTxns);
      if (needsRefresh) {
        const { balance: bal, pendingCount: pc } = await computeLocalBalance();
        setBalance(bal);
        setPendingCount(pc);
      }
    } catch (err) {
      console.error('Txn list error:', err);
    }
  }, [user?.token]);

  useEffect(() => {
    refreshBalance();
    refreshTransactions();
  }, [refreshBalance, refreshTransactions]);

  async function handleCancelPendingScan(txnId) {
    setCancellingTxn(txnId);
    try {
      await cancelSentTransaction(txnId);
      await refreshTransactions();
      await refreshBalance();
    } finally {
      setCancellingTxn(null);
    }
  }

  const handleSync = async () => {
    if (isOnline === false) {
      setSyncError('You are offline — server is unreachable. Transactions are saved locally.');
      return;
    }
    setSyncing(true);
    setSyncMessage(null);
    setSyncError(null);

    try {
      const result = await syncPendingTransactions(user.token, user.vpa, deviceId);

      if (result.synced === 0) {
        setSyncMessage('All transactions are up to date.');
      } else {
        const ok = result.results.filter((r) => r.respCode === '00').length;
        const fail = result.results.filter((r) => r.respCode !== '00').length;
        setSyncMessage(
          `Synced ${result.synced} transaction(s): ${ok} confirmed, ${fail} rejected.`
        );
        if (result.newBalance !== null) setServerBalance(result.newBalance);
      }

      await refreshBalance();
      await refreshTransactions();
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const fmt = (paise) => `₹${(paise / 100).toFixed(2)}`;

  return (
    <div className="dashboard">
      {/* ── Header ── */}
      <header className="dashboard-header">
        <div className="header-user">
          <span className="user-avatar">{user.displayName?.[0]?.toUpperCase() || '?'}</span>
          <div>
            <div className="user-name">{user.displayName}</div>
            <div className="user-vpa">{user.vpa}</div>
          </div>
        </div>
        <div className="header-right">
          <span className={`online-badge ${isOnline === null ? 'checking' : isOnline ? 'online' : 'offline'}`}>
            {isOnline === null ? '◌ Checking…' : isOnline ? '● Online' : '● Offline'}
          </span>
          <button className="btn-icon" onClick={onLogout} aria-label="Logout" title="Logout">⏻</button>
        </div>
      </header>

      {/* ── Balance Card ── */}
      <div className="balance-card">
        <div className="balance-label">Available Balance</div>
        <div className="balance-amount">
          {balanceLoading ? '…' : fmt(balance ?? 0)}
        </div>
        {pendingCount > 0 && (
          <div className="balance-pending">
            🔄 {pendingCount} transaction{pendingCount > 1 ? 's' : ''} pending sync
          </div>
        )}
        {serverBalance !== null && (
          <div className="balance-server">
            Server-confirmed: {fmt(serverBalance)}
          </div>
        )}
        {isOnline === false && (
          <div className="offline-note">
            📴 Offline — payments work locally, sync when reconnected
          </div>
        )}
      </div>

      {/* ── Action Buttons ── */}
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

      {/* ── Sync messages ── */}
      {syncMessage && (
        <div className="sync-message success" role="status">{syncMessage}</div>
      )}
      {syncError && (
        <div className="sync-message error" role="alert">{syncError}</div>
      )}

      {/* ── Transaction List ── */}
      <section className="transaction-list">
        <h3>Transactions</h3>

        {transactions.length === 0 ? (
          <div className="empty-state">No transactions yet. Send or receive to get started.</div>
        ) : (
          transactions.map((txn) => {
            const isSent = txn.direction === 'sent';
            const statusInfo = STATUS_LABELS[txn.status] || { label: txn.status, className: '', icon: '' };
            const isDoubleSpend = txn.status === TXN_STATUS.REJECTED_DOUBLE_SPEND;
            const isCancelled = txn.status === TXN_STATUS.CANCELLED;
            const isPendingScan = txn.status === TXN_STATUS.PENDING_SCAN;
            const showAmount = !isCancelled && !isPendingScan;
            const isExpanded = expandedTxn === txn.txnId;

            return (
              <div
                key={txn.txnId}
                className={`txn-item ${isSent ? 'sent' : 'received'} ${isCancelled ? 'cancelled' : ''}`}
              >
                {/* ── Main row ── */}
                <div
                  className="txn-main-row"
                  onClick={() => setExpandedTxn(isExpanded ? null : txn.txnId)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setExpandedTxn(isExpanded ? null : txn.txnId)}
                  aria-expanded={isExpanded}
                >
                  <span className={`txn-arrow-circle ${isSent ? 'sent' : 'received'}`}>
                    {isSent ? '↑' : '↓'}
                  </span>

                  <div className="txn-center">
                    <div className="txn-party">{txn.counterpartyVpa}</div>
                    <div className="txn-datetime">{formatDateTime(txn.timestamp)}</div>
                  </div>

                  <div className="txn-right">
                    <div className={`txn-amount ${isSent ? 'amount-sent' : 'amount-received'} ${!showAmount ? 'amount-void' : ''}`}>
                      {showAmount ? `${isSent ? '-' : '+'}${fmt(txn.amount)}` : '—'}
                    </div>
                    <div className={`txn-status-pill ${statusInfo.className}`}>
                      {statusInfo.icon} {statusInfo.label}
                    </div>
                  </div>
                </div>

                {/* ── Expanded detail row ── */}
                {isExpanded && (
                  <div className="txn-detail">
                    <div className="detail-row">
                      <span>Transaction ID</span>
                      <code className="detail-txnid">{txn.txnId}</code>
                    </div>
                    <div className="detail-row">
                      <span>Date &amp; Time</span>
                      <span>{formatDateTime(txn.timestamp)}</span>
                    </div>
                    <div className="detail-row">
                      <span>Amount</span>
                      <span>{showAmount ? fmt(txn.amount) : '—'}</span>
                    </div>
                    <div className="detail-row">
                      <span>Direction</span>
                      <span>{isSent ? 'Sent' : 'Received'}</span>
                    </div>
                    <div className="detail-row">
                      <span>Status</span>
                      <span className={`txn-status-pill ${statusInfo.className}`}>
                        {statusInfo.icon} {statusInfo.label}
                      </span>
                    </div>
                    {txn.rejectionReason && (
                      <div className="detail-row detail-warn">
                        <span>Reason</span>
                        <span>{txn.rejectionReason}</span>
                      </div>
                    )}
                    {/* Inline cancel for unscanned QRs */}
                    {isPendingScan && isSent && (
                      <button
                        className="btn-cancel-inline"
                        onClick={() => handleCancelPendingScan(txn.txnId)}
                        disabled={cancellingTxn === txn.txnId}
                      >
                        {cancellingTxn === txn.txnId ? 'Cancelling…' : '✕ Cancel this payment'}
                      </button>
                    )}
                    {isDoubleSpend && (
                      <div className="double-spend-warning" role="alert">
                        ⚠️ Rejected during sync — insufficient balance at settlement time. The recipient did not receive funds.
                      </div>
                    )}
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
