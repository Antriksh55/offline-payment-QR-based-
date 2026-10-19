/**
 * QR Code Generation — Module 3
 *
 * Encodes a signed transaction payload into a QR code.
 * Uses error-correction level M (not L) — demo conditions (phone screens,
 * indoor lighting) need at least level M to scan reliably.
 */

import QRCode from 'qrcode';

/**
 * Generate a QR code data URL from a signed transaction payload.
 * Minifies the payload (no whitespace) to maximize QR capacity.
 *
 * @param {object} signedTxn - the full signed payload
 * @returns {Promise<string>} data URL (PNG)
 */
export async function generateQRCode(signedTxn) {
  // Minify: no extra whitespace — pretty-printing wastes QR capacity
  const payload = JSON.stringify(signedTxn);

  const dataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M', // Level M — not L
    width: 400,
    margin: 2,
    color: {
      dark: '#1a1a1a',
      light: '#ffffff'
    }
  });

  return dataUrl;
}

/**
 * Generate QR code as an SVG string (useful for rendering without img tag).
 */
export async function generateQRCodeSVG(signedTxn) {
  const payload = JSON.stringify(signedTxn);
  return QRCode.toString(payload, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    width: 400,
    margin: 2
  });
}
