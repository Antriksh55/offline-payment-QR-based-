const express = require('express');
const router = express.Router();
const Bank = require('../models/Bank');

// ── GET /api/banks ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const banks = await Bank.find({}, '_id name code');
    res.json({ banks });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
