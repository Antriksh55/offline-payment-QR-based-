const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const VpaDirectory = require('../models/VpaDirectory');
const { requireAuth } = require('../middleware/auth');

// ── GET /api/transactions ────────────────────────────────────────────────────
// Transaction history for the authenticated user
router.get('/', requireAuth, async (req, res) => {
  try {
    const vpa = req.user.vpa;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const txns = await Transaction.find({
      $or: [{ senderVpa: vpa }, { receiverVpa: vpa }]
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Transaction.countDocuments({
      $or: [{ senderVpa: vpa }, { receiverVpa: vpa }]
    });

    res.json({ transactions: txns, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
