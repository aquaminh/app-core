import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
/**
 * Get encryption key from environment.
 * Must be a 64-character hex string (32 bytes).
 *
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
function getEncryptionKey() {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
        throw new Error('ENCRYPTION_KEY environment variable is not set');
    }
    if (key.length !== 64) {
        throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    }
    return Buffer.from(key, 'hex');
}
/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns a string in format: iv:tag:ciphertext (all hex encoded)
 */
export function encrypt(plaintext) {
    const key = getEncryptionKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}
/**
 * Decrypt ciphertext encrypted with encrypt().
 * Expects format: iv:tag:ciphertext (all hex encoded)
 */
export function decrypt(ciphertext) {
    const key = getEncryptionKey();
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid ciphertext format');
    }
    const [ivHex, tagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    if (iv.length !== IV_LENGTH) {
        throw new Error('Invalid IV length');
    }
    if (tag.length !== TAG_LENGTH) {
        throw new Error('Invalid auth tag length');
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
}
/**
 * Mask a string for display (show first/last few chars).
 * Useful for showing credential IDs without exposing full value.
 */
export function maskString(str, visibleStart = 4, visibleEnd = 4) {
    if (str.length <= visibleStart + visibleEnd) {
        return '*'.repeat(str.length);
    }
    const start = str.slice(0, visibleStart);
    const end = str.slice(-visibleEnd);
    const masked = '*'.repeat(Math.min(str.length - visibleStart - visibleEnd, 10));
    return `${start}${masked}${end}`;
}
/**
 * Check if encryption is properly configured.
 */
export function isEncryptionConfigured() {
    try {
        getEncryptionKey();
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=encryption.js.map