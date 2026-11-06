/**
 * Acknowledgement routes
 *
 * Lightweight in-memory ack store (TTL 10 minutes).
 * For a real system this would be Redis or a MongoDB collection.
 * For this demo, in-memory is fine — acks are only needed for the brief
 * window between receiver scanning and sender syncing.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// In-memory ack store: txnId → ack object
const ackStore = new Map();
const ACK_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Cleanup expired acks every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [txnId, ack] of ackStore.entries()) {
    if (now - ack.acceptedAt > ACK_TTL_MS) ackStore.delete(txnId);
  }
}, 5 * 60 * 1000);

// ── POST /api/ack ─────────────────────────────────────────────────────────────
// Receiver writes an ack after accepting a payment.
// Requires JWT — authenticated user's VPA must match receiverVpa.
// This prevents an attacker from posting a fake ack for someone else's txnId.
router.post('/', requireAuth, (req, res) => {
  const { txnId, receiverVpa, acceptedAt, status, reason } = req.body;
  if (!txnId || !receiverVpa || !status) {
    return res.status(400).json({ error: 'txnId, receiverVpa, and status are required' });
  }
  // Validate: the authenticated user must be the claimed receiver
  if (req.user.vpa !== receiverVpa) {
    return res.status(403).json({ error: 'You can only submit an ack for your own VPA' });
  }
  ackStore.set(txnId, { txnId, receiverVpa, acceptedAt: acceptedAt || Date.now(), status, reason });
  res.json({ success: true });
});

// ── GET /api/ack/:txnId ───────────────────────────────────────────────────────
// Sender polls for an ack — no auth needed (txnId is hard to guess: UUID v4)
router.get('/:txnId', (req, res) => {
  const ack = ackStore.get(req.params.txnId) || null;
  res.json({ ack });
});

module.exports = router;
