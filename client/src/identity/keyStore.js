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
const DB_VERSION = 1;
const KEYSTORE_STORE = 'keystore';
const KEYPAIR_KEY = 'userKeypair';

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
      // keystore: stores the keypair
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
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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
