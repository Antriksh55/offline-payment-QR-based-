/**
 * Offline-to-Offline QR Payment System — Backend Entry Point
 *
 * Requires MongoDB running as a replica set for multi-document transactions:
 *   mongod --replSet rs0
 * Or use MongoDB Atlas (replica set by default).
 *
 * MONGODB_URI should point to a replica set, e.g.:
 *   mongodb://127.0.0.1:27017/offlinepay?replicaSet=rs0
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');

const authRoutes = require('./routes/auth');
const syncRoutes = require('./routes/sync');
const balanceRoutes = require('./routes/balance');
const ackRoutes = require('./routes/ack');
const settlementRoutes = require('./routes/settlement');
const floatRoutes = require('./routes/float');
const bankRoutes = require('./routes/banks');
const transactionRoutes = require('./routes/transactions');
const { expireStaleFloats } = require('./float');
const Bank = require('./models/Bank');

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/offlinepay?replicaSet=rs0';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/balance', balanceRoutes);
app.use('/api/ack', ackRoutes);
app.use('/api/settlement', settlementRoutes);
app.use('/api/float', floatRoutes);
app.use('/api/banks', bankRoutes);
app.use('/api/transactions', transactionRoutes);

// Health check
app.get('/api/health', (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? 'ok' : 'degraded',
    dbState: dbConnected ? 'connected' : 'disconnected',
    time: new Date().toISOString()
  });
});

// ── MongoDB connection ─────────────────────────────────────────────────────
async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ MongoDB connected:', MONGODB_URI);

    // Auto-reconnect on disconnect
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected — retrying in 5s…');
      setTimeout(() => mongoose.connect(MONGODB_URI).catch(() => {}), 5000);
    });
    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB reconnected');
    });

    // Seed the two fake banks if they don't exist
    await seedBanks();
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    console.error('Make sure MongoDB is running as a replica set:');
    console.error('  mongod --replSet rs0');
    console.error('  Then in mongosh: rs.initiate()');
    process.exit(1);
  }
}

async function seedBanks() {
  const count = await Bank.countDocuments();
  if (count === 0) {
    await Bank.insertMany([
      { name: 'FakeBank A', code: 'fakebanka' },
      { name: 'FakeBank B', code: 'fakebankb' }
    ]);
    console.log('✅ Seeded FakeBank A and FakeBank B');
  }
}

// ── Scheduled jobs ────────────────────────────────────────────────────────────
// Check for expired offline floats every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  const expired = await expireStaleFloats();
  if (expired > 0) console.log(`[Cron] Expired ${expired} stale float(s)`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('   API endpoints:');
    console.log('   POST /api/auth/request-otp');
    console.log('   POST /api/auth/verify-otp');
    console.log('   POST /api/auth/bind-key');
    console.log('   POST /api/auth/challenge');
    console.log('   POST /api/auth/verify-challenge');
    console.log('   POST /api/sync');
    console.log('   GET  /api/balance/:vpa');
    console.log('   POST /api/settlement/run');
    console.log('   GET  /api/settlement/ledger-check');
    console.log('   POST /api/float/request');
  });
});
