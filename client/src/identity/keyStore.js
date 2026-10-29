/**
 * Identity & Key Management — Module 1
 *
 * Manages Ed25519 keypair generation and IndexedDB storage.
 *
 * SECURITY NOTE: In this demo, the private key is stored in IndexedDB as a
 * base64 string for simplicity. In a production system, the private key should
 * be stored using the Web Crypto API's non-extractable CryptoKey format
 * (importKey with extractable=false), backed by hardware-level isolation where
 * available (Secure Enclave on iOS, Android Keystore, TPM on Windows). IndexedDB
 * keys are extractable by the page's JavaScript and by anyone with DevTools access.
 * This is acceptable for a demo, not for real financial apps.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

const DB_NAME = 'OfflinePaymentDB';
const DB_VERSION = 2;          // bumped: added 'pinstore' object store
const KEYSTORE_STORE = 'keystore';
const KEYPAIR_KEY = 'userKeypair';
const PIN_STORE = 'pinstore';
const PIN_KEY = 'upiPin';

let dbPromise = null;

/**
 * Open (or create) the IndexedDB database with all required object stores.
 */
function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // keystore: stores the Ed25519 keypair
      if (!db.objectStoreNames.contains(KEYSTORE_STORE)) {
        db.createObjectStore(KEYSTORE_STORE);
      }
      // localTransactions: pending and confirmed transactions
      if (!db.objectStoreNames.contains('localTransactions')) {
        const txStore = db.createObjectStore('localTransactions', { keyPath: 'txnId' });
        txStore.createIndex('status', 'status', { unique: false });
      }
      // usedNonces: replay protection
      if (!db.objectStoreNames.contains('usedNonces')) {
        db.createObjectStore('usedNonces', { keyPath: 'nonce' });
      }
      // walletMeta: cached balance and sync state
      if (!db.objectStoreNames.contains('walletMeta')) {
        db.createObjectStore('walletMeta');
      }
      // pinstore: stores the hashed UPI PIN (set during registration)
      // SECURITY NOTE: In production, use PBKDF2 or bcrypt with a salt stored separately.
      // For this demo, we use SHA-256 via Web Crypto (available offline, no library needed).
      if (!db.objectStoreNames.contains(PIN_STORE)) {
        db.createObjectStore(PIN_STORE);
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      // Reset the cached promise if the connection closes unexpectedly
      // (happens on version upgrade or browser-initiated close).
      // Without this, the stale closed connection stays cached and every
      // subsequent IDB call throws "The database connection is closing."
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };

      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null; // allow retry on next call
      reject(request.error);
    };
    request.onblocked = () => {
      // Another tab has the DB open at an older version — close ours when possible
      console.warn('[IDB] Upgrade blocked by another tab. Please close other tabs and reload.');
    };
  });

  return dbPromise;
}

/**
 * Get (or generate) the user's Ed25519 keypair.
 * Reuses any existing keypair from IndexedDB — never generates a duplicate
 * if one already exists (handles the "reload before registration" edge case).
 *
 * @returns {{ publicKeyB64: string, privateKeyB64: string }}
 */
export async function getOrCreateKeypair() {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYSTORE_STORE, 'readwrite');
    const store = tx.objectStore(KEYSTORE_STORE);
    const getReq = store.get(KEYPAIR_KEY);

    getReq.onsuccess = () => {
      if (getReq.result) {
        // Reuse existing keypair
        resolve(getReq.result);
        return;
      }

      // Generate new Ed25519 keypair
      const keypair = nacl.sign.keyPair();
      const stored = {
        publicKeyB64: encodeBase64(keypair.publicKey),
        privateKeyB64: encodeBase64(keypair.secretKey)
      };

      const putReq = store.put(stored, KEYPAIR_KEY);
      putReq.onsuccess = () => resolve(stored);
      putReq.onerror = () => reject(putReq.error);
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Get the current keypair without generating a new one.
 * Returns null if no keypair is stored yet.
 */
export async function getKeypair() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYSTORE_STORE, 'readonly');
    const store = tx.objectStore(KEYSTORE_STORE);
    const req = store.get(KEYPAIR_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Replace the keypair (e.g. after a key rotation to a new device).
 * The old private key is gone once this is called.
 */
export async function replaceKeypair(publicKeyB64, privateKeyB64) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYSTORE_STORE, 'readwrite');
    const store = tx.objectStore(KEYSTORE_STORE);
    const req = store.put({ publicKeyB64, privateKeyB64 }, KEYPAIR_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export { openDB };

// ── UPI PIN helpers ────────────────────────────────────────────────────────

/**
 * Hash a PIN using SHA-256 via the Web Crypto API.
 * Works fully offline — no library needed.
 * In production use PBKDF2 with a unique salt per device.
 */
async function hashPin(pin) {
  const data = new TextEncoder().encode(`offlinepay:${pin}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Save a new UPI PIN (hashed) to IndexedDB.
 * Called once during registration, or on PIN change.
 * @param {string} pin - 4-6 digit PIN (plain text — never stored raw)
 */
export async function savePin(pin) {
  const db = await openDB();
  const hashed = await hashPin(pin);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PIN_STORE, 'readwrite');
    const store = tx.objectStore(PIN_STORE);
    const req = store.put(hashed, PIN_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Verify a PIN against the stored hash.
 * Returns true if correct, false if wrong, null if no PIN is set yet.
 * Works 100% offline — no server call needed.
 * @param {string} pin - plain text PIN entered by user
 */
export async function verifyPin(pin) {
  const db = await openDB();
  const storedHash = await new Promise((resolve, reject) => {
    const tx = db.transaction(PIN_STORE, 'readonly');
    const store = tx.objectStore(PIN_STORE);
    const req = store.get(PIN_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });

  if (storedHash === null) return null; // PIN not set yet
  const enteredHash = await hashPin(pin);
  return enteredHash === storedHash;
}

/**
 * Check if a PIN has been set for this device.
 */
export async function hasPin() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PIN_STORE, 'readonly');
    const store = tx.objectStore(PIN_STORE);
    const req = store.get(PIN_KEY);
    req.onsuccess = () => resolve(req.result !== undefined && req.result !== null);
    req.onerror = () => reject(req.error);
  });
}
