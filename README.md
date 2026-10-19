# Offline-to-Offline QR Payment System

A full-stack demo payment platform that lets two users transfer money using a QR code with **zero internet connection required for the transfer itself**, backed by a simplified real-world banking protocol modeled after UPI/NPCI.

---

## Architecture Overview

```
client (React/Vite)              server (Node/Express)
├── identity/         ←→         ├── models/
│   └── keyStore.js              │   ├── Bank, User, VpaDirectory
│       (Ed25519 keypair,        │   ├── Account, Transaction
│        IndexedDB, never        │   ├── LedgerEntry, SettlementBatch
│        transmitted)            │   └── OtpChallenge, OfflineFloat
│
├── transaction/                 ├── switch/       ← routing & validation
│   └── builder.js               │   (sig verify, nonce, balance, float)
│       (sign, canonical msg)
│
├── qr/                          ├── ledger/
│   └── qrGenerator.js          │   └── getBalance() — always aggregated,
│       (qrcode, level M)       │       never a stored mutable field
│
├── ledger/                      ├── settlement/
│   └── localLedger.js          │   └── NEFT-style batch netting
│       (IndexedDB: txns,
│        nonces, wallet meta)   ├── float/
│                                │   └── offline escrow / HOLD entries
├── sync/
│   └── syncService.js          └── routes/
│       (POST /api/sync)            auth, sync, settlement, float, banks
```

---

## Prerequisites

- **Node.js 18+**
- **MongoDB** running as a **replica set** (required for multi-document transactions)

### Start MongoDB as a replica set (local dev)

```bash
# First-time setup only:
mongod --replSet rs0 --dbpath ./data/db --port 27017

# In a separate terminal (mongosh):
mongosh
rs.initiate()
# You should see: { ok: 1 }
```

Or use **MongoDB Atlas** (replica set by default — just update `MONGODB_URI`).

---

## Quick Start

### 1. Install dependencies

```bash
# From the repo root
cd server && npm install
cd ../client && npm install
```

### 2. Configure environment

```bash
# server/.env (already created with defaults)
PORT=3001
MONGODB_URI=mongodb://127.0.0.1:27017/offlinepay?replicaSet=rs0
JWT_SECRET=change-this-in-production
CLIENT_ORIGIN=http://localhost:5173
```

### 3. Start the backend

```bash
cd server
npm run dev     # uses nodemon for auto-reload
```

On first run, FakeBank A and FakeBank B are auto-seeded. Each new user gets a ₹5,000 starting balance.

### 4. Start the frontend

```bash
cd client
npm run dev
```

Open **http://localhost:5173**

---

## Full Offline-to-Offline Demo

Use **two browser tabs** (or two devices on the same network):

1. **Tab A** — Register as "Alice" on FakeBank A
2. **Tab B** — Register as "Bob" on FakeBank B
3. **Tab A (Alice)** — Send → enter ₹100 → QR code appears
4. **Tab B (Bob)** — Receive → Scan the QR from Tab A's screen
5. Both tabs show the transaction as **⏳ Pending Sync**
6. **Either tab** — tap Sync → transaction processes through the Switch
7. Both tabs update to **✅ Confirmed**
8. **Admin panel** → Run Settlement → creates interbank settlement batch

---

## Response Code Reference

| Code | Meaning |
|------|---------|
| 00 | Success |
| 01 | Insufficient funds |
| 02 | Invalid VPA |
| 03 | Double-spend / exceeds offline float |
| 04 | Bad signature |
| 05 | Nonce replay |
| 06 | Stale/replayed device sequence |
| 07 | Stale/unauthorized device key (post key rotation) |
| 08 | Timestamp outside ±5-minute window |

---

## Key Design Decisions

### Balance is never stored as a mutable number
`getBalance(accountNumber)` always aggregates `LedgerEntry` documents. No cached balance field anywhere — server or client.

### Double-entry ledger invariant
Every successful transaction posts exactly one DEBIT + one CREDIT inside a MongoDB multi-document transaction. `GET /api/settlement/ledger-check` verifies `SUM(DEBITs) === SUM(CREDITs)` across the whole database.

### Offline float (bounded double-spend protection)
When online, the server reserves funds via a `HOLD` ledger entry. The device can spend offline up to `reservedAmount` (≤ ₹2,000 demo limit). During sync, cumulative deviceSeq is checked so a device-restore replay attack fails with respCode 06.

### Key rotation actually revokes old devices
The Switch looks up the sender's **currently registered** public key from the database, not the key embedded in the transaction payload. A transaction signed by a rotated-out key gets respCode 07.

### On-screen OTP (no SMS integration)
The demo returns the OTP directly in the API response for display on screen. A production deployment would swap the `demoOtp` return value for an SMS gateway call — no other changes needed.

---

## Sanity Checks (run before demo)

```bash
# 1. Ledger balanced?
GET http://localhost:3001/api/settlement/ledger-check

# 2. Scan same QR twice — second scan rejected locally (nonce replay)

# 3. Send more than balance offline → respCode 01 on sync

# 4. Send more than float (₹2000) offline → blocked client-side (UX)
#    or respCode 03 if bypassed

# 5. Rotate key (new device login) → old device's transactions → respCode 07
```
