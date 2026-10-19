/**
 * Offline Float routes — Module 12
 */

const express = require('express');
const router = express.Router();
const { requestFloat } = require('../float');
const OfflineFloat = require('../models/OfflineFloat');
const { requireAuth } = require('../middleware/auth');

// ── POST /api/float/request ──────────────────────────────────────────────────
// Request or refresh an offline float. Called while online (e.g., after login/sync).
router.post('/request', requireAuth, async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const vpa = req.user.vpa;
    const result = await requestFloat(vpa, deviceId);

    res.json({
      success: true,
      ...result,
      message: result.reused
        ? 'Existing active float returned'
        : 'New offline float issued — funds reserved'
    });
  } catch (err) {
    console.error('Float request error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/float/status ────────────────────────────────────────────────────
// Check current float status for the authenticated user
router.get('/status', requireAuth, async (req, res) => {
  try {
    const VpaDirectory = require('../models/VpaDirectory');
    const vpaEntry = await VpaDirectory.findOne({ vpa: req.user.vpa, active: true });
    if (!vpaEntry) return res.status(404).json({ error: 'Account not found' });

    const float = await OfflineFloat.findOne({
      accountNumber: vpaEntry.accountNumber,
      status: 'ACTIVE'
    });

    if (!float) {
      return res.json({ hasActiveFloat: false });
    }

    res.json({
      hasActiveFloat: true,
      reservedAmount: float.reservedAmount,
      spentSoFar: float.spentSoFar,
      remaining: float.reservedAmount - float.spentSoFar,
      expiresAt: float.expiresAt,
      deviceId: float.deviceId,
      startingSeq: float.startingSeq
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
