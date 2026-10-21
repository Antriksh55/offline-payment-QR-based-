/**
 * Balance route — GET /api/balance/:vpa
 * Returns the authoritative server-side balance for a VPA.
 * Mounted at /api/balance so the full path is /api/balance/:vpa
 */

const express = require('express');
const router = express.Router();
const VpaDirectory = require('../models/VpaDirectory');
const { getBalance } = require('../ledger');

// GET /api/balance/:vpa
router.get('/:vpa', async (req, res) => {
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
