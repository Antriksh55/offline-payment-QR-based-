/**
 * Balance routes
 * GET /api/balance/:vpa         — basic balance (balance + available)
 * GET /api/balance/detail/:vpa  — full reservation breakdown:
 *   Total Wallet Balance         = credits - debits
 *   Reserved Offline Amount      = active HOLD (offline float escrow)
 *   Available Offline Amount     = balance - reserved
 *   Pending Reconciliation Amount = sum of PENDING_SYNC transactions not yet settled
 */

const express = require('express');
const router = express.Router();
const VpaDirectory = require('../models/VpaDirectory');
const OfflineFloat = require('../models/OfflineFloat');
const Transaction = require('../models/Transaction');
const { getBalance } = require('../ledger');

// GET /api/balance/:vpa — basic
router.get('/:vpa', async (req, res) => {
  if (req.params.vpa === 'detail') return; // let the detail route handle it
  try {
    const { vpa } = req.params;
    const vpaEntry = await VpaDirectory.findOne({ vpa, active: true });
    if (!vpaEntry) return res.status(404).json({ error: 'VPA not found' });

    const { balance, available } = await getBalance(vpaEntry.accountNumber);
    res.json({ vpa, balance, available, accountNumber: vpaEntry.accountNumber });
  } catch (err) {
    console.error('Balance error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/balance/detail/:vpa — full reservation breakdown
router.get('/detail/:vpa', async (req, res) => {
  try {
    const { vpa } = req.params;
    const vpaEntry = await VpaDirectory.findOne({ vpa, active: true });
    if (!vpaEntry) return res.status(404).json({ error: 'VPA not found' });

    const accountNumber = vpaEntry.accountNumber;

    // 1. Server-computed balance components
    const { balance, available } = await getBalance(accountNumber);

    // 2. Active offline float (reserved amount currently held in escrow)
    const activeFloat = await OfflineFloat.findOne({ accountNumber, status: 'ACTIVE' });
    const reservedOfflineAmount = activeFloat ? activeFloat.reservedAmount : 0;
    const floatSpentSoFar = activeFloat ? activeFloat.spentSoFar : 0;
    const availableOfflineAmount = reservedOfflineAmount - floatSpentSoFar;

    // 3. Pending reconciliation: sum of PENDING_SETTLEMENT transactions from this VPA
    const pendingResult = await Transaction.aggregate([
      {
        $match: {
          senderVpa: vpa,
          status: 'PENDING_SETTLEMENT'
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const pendingReconciliationAmount = pendingResult[0]?.total || 0;

    res.json({
      vpa,
      accountNumber,
      // ── The 4 reservation values ───────────────────────────────────────
      totalWalletBalance: balance,                // credits - debits (posted)
      reservedOfflineAmount,                      // active HOLD (escrow for offline float)
      availableOfflineAmount,                     // float remaining for offline spends
      pendingReconciliationAmount,                // PENDING_SETTLEMENT txns not yet settled
      // ── Derived ────────────────────────────────────────────────────────
      availableToSpend: available,                // balance - all active holds
      floatExpiresAt: activeFloat?.expiresAt || null,
      hasActiveFloat: !!activeFloat,
      // ── Example display ────────────────────────────────────────────────
      display: {
        'Total Wallet Balance': `₹${(balance / 100).toFixed(2)}`,
        'Offline Spending Allocation': `₹${(reservedOfflineAmount / 100).toFixed(2)}`,
        'Spent Offline (pending sync)': `₹${(floatSpentSoFar / 100).toFixed(2)}`,
        'Available Offline': `₹${(availableOfflineAmount / 100).toFixed(2)}`,
        'Pending Reconciliation': `₹${(pendingReconciliationAmount / 100).toFixed(2)}`,
        'Available to Spend Online': `₹${(available / 100).toFixed(2)}`
      }
    });
  } catch (err) {
    console.error('Balance detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
