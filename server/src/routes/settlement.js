/**
 * Settlement routes — Module 9
 */

const express = require('express');
const router = express.Router();
const { runSettlement } = require('../settlement');
const SettlementBatch = require('../models/SettlementBatch');
const { checkLedgerInvariant } = require('../ledger');
const { requireAuth } = require('../middleware/auth');
const Transaction = require('../models/Transaction');

// ── POST /api/settlement/run ─────────────────────────────────────────────────
// Admin-triggered settlement run. Requires auth.
router.post('/run', requireAuth, async (req, res) => {
  try {
    const result = await runSettlement();
    res.json({
      success: true,
      batchesCreated: result.batches.length,
      transactionsSettled: result.txnsSettled,
      batches: result.batches
    });
  } catch (err) {
    console.error('Settlement error:', err);
    res.status(500).json({ error: 'Settlement failed: ' + err.message });
  }
});

// ── GET /api/settlement/batches ──────────────────────────────────────────────
router.get('/batches', requireAuth, async (req, res) => {
  try {
    const batches = await SettlementBatch.find()
      .sort({ runAt: -1 })
      .limit(50)
      .populate('bankPair');
    res.json({ batches });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/settlement/ledger-check ────────────────────────────────────────
// Debug endpoint: verify the double-entry invariant across the whole ledger.
// SUM(all DEBITs) must always equal SUM(all CREDITs).
router.get('/ledger-check', async (req, res) => {
  try {
    const result = await checkLedgerInvariant();
    res.json({
      ...result,
      message: result.balanced
        ? '✅ Ledger is balanced'
        : `❌ Ledger IMBALANCE: DEBITs=${result.debitTotal}, CREDITs=${result.creditTotal}`
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/settlement/pending ──────────────────────────────────────────────
router.get('/pending', requireAuth, async (req, res) => {
  try {
    const count = await Transaction.countDocuments({ status: 'PENDING_SETTLEMENT' });
    const txns = await Transaction.find({ status: 'PENDING_SETTLEMENT' }).sort({ createdAt: -1 }).limit(20);
    res.json({ count, transactions: txns });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
