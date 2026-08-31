"use strict";
/**
 * Unified cron authentication for all scheduled routes.
 *
 * Supports two auth methods:
 *   1. Bearer token (GET) — for manual testing and simple cron callers
 *   2. QStash signature (POST) — for Upstash QStash scheduled jobs
 *
 * Reads CRON_SECRET, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY from env.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyCronAuth = verifyCronAuth;
const node_crypto_1 = require("node:crypto");
let _receiverPromise = null;
// Memoized so concurrent first requests share one import - otherwise a second
// cold-start QStash call could observe a half-initialized state and 401 a
// validly-signed request.
function getReceiver() {
    _receiverPromise ??= (async () => {
        if (!process.env.QSTASH_CURRENT_SIGNING_KEY || !process.env.QSTASH_NEXT_SIGNING_KEY) {
            return null;
        }
        // Dynamic import keeps @upstash/qstash an optional peer AND works in pure
        // Node ESM - this dist is ESM, where a bare require() is a ReferenceError
        // outside bundlers that shim it.
        const { Receiver } = await Promise.resolve().then(() => __importStar(require('@upstash/qstash')));
        return new Receiver({
            currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
            nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
        });
    })();
    return _receiverPromise;
}
let _warnedMissingSecret = false;
/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length)
        return false;
    return (0, node_crypto_1.timingSafeEqual)(bufA, bufB);
}
async function verifyCronAuth(request, body) {
    // Method 1: Bearer token (typically GET requests or manual calls).
    // Guard against an unset CRON_SECRET — without it, the literal header
    // "Bearer undefined" would authenticate on any deployment missing the env var.
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret && !_warnedMissingSecret) {
        _warnedMissingSecret = true;
        // Misconfiguration, not an auth failure: name the env var so a deployment
        // missing it doesn't 401 every cron route with no pointer to the cause.
        console.warn('[app-core/cron] CRON_SECRET is not set - Bearer cron auth is disabled');
    }
    const authHeader = request.headers.get('authorization');
    if (cronSecret && authHeader && safeEqual(authHeader, `Bearer ${cronSecret}`)) {
        return { authorized: true, method: 'bearer' };
    }
    // Method 2: QStash signature (POST requests from Upstash)
    try {
        const receiver = await getReceiver();
        if (receiver) {
            const signature = request.headers.get('upstash-signature');
            if (signature) {
                const isValid = await receiver.verify({
                    signature,
                    body: body ?? '',
                });
                if (isValid) {
                    return { authorized: true, method: 'qstash' };
                }
            }
        }
    }
    catch {
        // Import or signature verification failed — fall through to unauthorized
    }
    return { authorized: false, method: 'none' };
}
