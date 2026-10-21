/**
 * Sync endpoint — Module 8
 *
 * Accepts a batch of signed transaction payloads from the client,
 * runs each through the Switch sequentially, and returns per-transaction results.
 *
 * NOTE: JWT is optional for sync — the Switch validates each transaction
 * by its own Ed25519 signature independently of session state.
 * A sync call with an expired JWT still processes transactions correctly.
 */

const express = require('express');
const router = express.Router();
const { processBatch } = require('../switch');
const VpaDirectory = require('../models/VpaDirectory');
const { getBalance } = require('../ledger');
const { reconcileFloat } = require('../float');

// ── POST /api/sync ───────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { deviceId, transactions, floatDeviceId } = req.body;

    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'transactions must be a non-empty array' });
    }

    // Validate minimal shape of each transaction
    for (const txn of transactions) {
      if (!txn.txnId || !txn.senderVpa || !txn.receiverVpa || !txn.amount || !txn.nonce) {
        return res.status(400).json({
          error: `Transaction missing required fields: txnId, senderVpa, receiverVpa, amount, nonce`
        });
      }
    }

    // Process sequentially — order matters for correct double-spend detection
    const results = await processBatch(transactions, floatDeviceId || null);

    // After successful sync, attempt to reconcile the float if all transactions for this
    // device are now processed. The reconcileFloat function checks if the float can be closed.
    if (floatDeviceId) {
      try {
        await reconcileFloat(floatDeviceId);
      } catch (floatErr) {
        console.warn('Float reconciliation warning:', floatErr.message);
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// ── GET /api/sync/balance/:vpa (kept for backward compat) ───────────────────
// Primary balance endpoint is now GET /api/balance/:vpa (see routes/balance.js)
router.get('/balance/:vpa', async (req, res) => {
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

module.exports = router;
