/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns a string in format: iv:tag:ciphertext (all hex encoded)
 */
export declare function encrypt(plaintext: string): string;
/**
 * Decrypt ciphertext encrypted with encrypt().
 * Expects format: iv:tag:ciphertext (all hex encoded)
 */
export declare function decrypt(ciphertext: string): string;
/**
 * Mask a string for display (show first/last few chars).
 * Useful for showing credential IDs without exposing full value.
 */
export declare function maskString(str: string, visibleStart?: number, visibleEnd?: number): string;
/**
 * Check if encryption is properly configured.
 */
export declare function isEncryptionConfigured(): boolean;
//# sourceMappingURL=encryption.d.ts.map