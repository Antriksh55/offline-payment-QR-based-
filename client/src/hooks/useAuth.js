/**
 * useAuth hook — manages authentication state, login, and logout.
 * Uses localStorage for JWT and VPA (not sensitive data).
 * Private keys stay in IndexedDB only.
 */

import { useState, useEffect, useCallback } from 'react';
import { getKeypair, getOrCreateKeypair } from '../identity/keyStore';
import { api } from '../api/client';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import nacl from 'tweetnacl';
import { updateWalletMeta } from '../ledger/localLedger';

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null); // { vpa, displayName, token }
  const [loading, setLoading] = useState(true);

  // On mount: check for existing session
  useEffect(() => {
    const token = localStorage.getItem('authToken');
    const vpa = localStorage.getItem('userVpa');
    const displayName = localStorage.getItem('userDisplayName');

    if (token && vpa) {
      setUser({ token, vpa, displayName });
      setIsAuthenticated(true);
    }
    setLoading(false);
  }, []);

  /**
   * Try silent login via challenge-response (same device, existing keypair).
   * Returns true if successful, false if OTP flow is needed.
   */
  const trySilentLogin = useCallback(async () => {
    const vpa = localStorage.getItem('userVpa');
    if (!vpa) return false;

    const keypair = await getKeypair();
    if (!keypair) return false;

    try {
      const { challenge } = await api.getChallenge(vpa);

      // Sign the challenge with our private key
      const challengeBytes = new TextEncoder().encode(challenge);
      const privateKeyBytes = decodeBase64(keypair.privateKeyB64);
      const sigBytes = nacl.sign.detached(challengeBytes, privateKeyBytes);
      const signature = encodeBase64(sigBytes);

      const result = await api.verifyChallenge(vpa, challenge, signature);

      localStorage.setItem('authToken', result.token);
      localStorage.setItem('userVpa', result.vpa);
      localStorage.setItem('userDisplayName', result.displayName);

      setUser({ token: result.token, vpa: result.vpa, displayName: result.displayName });
      setIsAuthenticated(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  const login = useCallback((token, vpa, displayName) => {
    localStorage.setItem('authToken', token);
    localStorage.setItem('userVpa', vpa);
    localStorage.setItem('userDisplayName', displayName || '');
    setUser({ token, vpa, displayName });
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('userVpa');
    localStorage.removeItem('userDisplayName');
    setUser(null);
    setIsAuthenticated(false);
    // Note: we intentionally do NOT delete IndexedDB keys on logout.
    // The keypair persists for silent re-login on the same device.
  }, []);

  return { isAuthenticated, user, loading, login, logout, trySilentLogin };
}
