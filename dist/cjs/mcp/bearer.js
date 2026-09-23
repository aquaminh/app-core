"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractBearer = extractBearer;
/**
 * Read the bearer credential out of an Authorization header.
 *
 * Same regex as zeebrar's original `extractBearer` so behaviour is identical:
 * the scheme is case-insensitive, surrounding whitespace is ignored, and any
 * other scheme (Basic, Token, ...) yields null.
 */
function extractBearer(authorization) {
    if (typeof authorization !== 'string' || !authorization)
        return null;
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return match ? match[1].trim() : null;
}
