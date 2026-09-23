"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfirmUnavailableError = void 0;
exports.canonicalJson = canonicalJson;
exports.hashArgs = hashArgs;
exports.createConfirmGate = createConfirmGate;
/**
 * Server-side two-phase confirmation gate for MCP write tools.
 *
 * A client-side "are you sure" is bypassed by definition when the caller is
 * an API client, so the gate lives on the server:
 *
 *   phase 1  the tool is called WITHOUT a confirmation token: the app computes
 *            the full plan, executes nothing, and issue() returns an opaque
 *            token bound to { tokenId, tool, sha256(canonical args) }.
 *   phase 2  the same call WITH the token: verify() recomputes the binding;
 *            a different token, a different tool, drifted args, a replay or
 *            an expired token is rejected. ok is returned exactly once.
 *
 * Differences from zeebrar's original gate, all deliberate:
 *   1. Domain-separated MAC key: HMAC-SHA256(secret, 'app-core:mcp-confirm:v1')
 *      instead of the raw secret, so an app secret that also signs other
 *      things (Connector JWTs, sessions) never MACs confirmation payloads.
 *   2. Claims { v, tid, tool, ah, n, iat, exp }. Binding mismatches return
 *      before the nonce is consumed, so a mismatch never burns the token.
 *   3. No silent in-memory fallback: `whenRedisMissing` is required. Under
 *      NODE_ENV=production 'memory' is treated as 'deny', so a deployment that
 *      lost its Redis env fails closed instead of going process-local. Redis
 *      errors throw ConfirmUnavailableError in issue() and return
 *      UNAVAILABLE from verify().
 *   4. The injected Redis client MUST be a no-store client, e.g.
 *      `new Redis({ url, token, cache: 'no-store' })`. app-core's cache client
 *      uses `cache: 'force-cache'`, and Next.js replays force-cache fetch
 *      responses from its Data Cache: a replayed `DEL <nonce>` answering 1
 *      would consume the same nonce twice and defeat single use. Route
 *      handlers using the gate should also set `fetchCache = 'force-no-store'`.
 */
const node_crypto_1 = require("node:crypto");
/** The nonce store is missing (under 'deny') or failed. Nothing was issued. */
class ConfirmUnavailableError extends Error {
    constructor(message = 'Confirmation store is unavailable', options) {
        super(message, options);
        this.name = 'ConfirmUnavailableError';
    }
}
exports.ConfirmUnavailableError = ConfirmUnavailableError;
const KEY_DERIVATION_LABEL = 'app-core:mcp-confirm:v1';
const CLAIMS_VERSION = 1;
const NONCE_BYTES = 16;
const DEFAULT_TTL_SECONDS = 300;
function encode(input) {
    let value = input;
    // Mirror JSON.stringify: honour toJSON (so Dates bind by value, not as {}).
    if (value !== null && typeof value === 'object' && typeof value.toJSON === 'function') {
        value = value.toJSON();
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
        return undefined;
    if (Array.isArray(value))
        return `[${value.map((item) => encode(item) ?? 'null').join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const entries = [];
        for (const [key, item] of Object.entries(value)) {
            const encoded = encode(item);
            if (encoded !== undefined)
                entries.push([key, encoded]);
        }
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, encoded]) => `${JSON.stringify(key)}:${encoded}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
/**
 * Stable JSON: object keys sorted, undefined (and function/symbol) members
 * dropped, so { a, b } and { b, a } hash identically. Array holes and
 * undefined elements encode as null, and a top-level undefined as 'null',
 * matching JSON.stringify.
 */
function canonicalJson(value) {
    return encode(value) ?? 'null';
}
/** sha256 hex of canonicalJson(args). */
function hashArgs(args) {
    return (0, node_crypto_1.createHash)('sha256').update(canonicalJson(args)).digest('hex');
}
function safeEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length)
        return false;
    return (0, node_crypto_1.timingSafeEqual)(bufA, bufB);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function parseClaims(payload) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object')
        return null;
    const c = parsed;
    if (c.v !== CLAIMS_VERSION)
        return null;
    if (!isNonEmptyString(c.tid) || !isNonEmptyString(c.tool) || !isNonEmptyString(c.ah) || !isNonEmptyString(c.n)) {
        return null;
    }
    if (typeof c.iat !== 'number' || !Number.isFinite(c.iat) || typeof c.exp !== 'number' || !Number.isFinite(c.exp)) {
        return null;
    }
    return c;
}
function durationLabel(seconds) {
    if (seconds % 60 === 0) {
        const minutes = seconds / 60;
        return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `${seconds} seconds`;
}
function createConfirmGate(config) {
    if (!config || typeof config !== 'object') {
        throw new TypeError('[app-core/mcp] createConfirmGate needs a config object');
    }
    const { secret, keyPrefix, whenRedisMissing } = config;
    if (whenRedisMissing !== 'memory' && whenRedisMissing !== 'deny') {
        throw new TypeError("[app-core/mcp] whenRedisMissing is required: 'deny' (production) or 'memory' (single-process dev only)");
    }
    if (!isNonEmptyString(keyPrefix)) {
        throw new TypeError('[app-core/mcp] keyPrefix must be a non-empty string');
    }
    if (typeof secret !== 'string' && typeof secret !== 'function') {
        throw new TypeError('[app-core/mcp] secret must be a string or a function returning one');
    }
    const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
        throw new TypeError('[app-core/mcp] ttlSeconds must be a positive whole number');
    }
    const redis = config.redis ?? null;
    if (redis !== null && (typeof redis.set !== 'function' || typeof redis.del !== 'function')) {
        throw new TypeError('[app-core/mcp] redis must provide set() and del(), or be null');
    }
    const now = config.now ?? Date.now;
    const onWarn = config.onWarn ?? ((message) => console.warn(`[app-core/mcp] ${message}`));
    const production = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
    const missingMode = whenRedisMissing === 'memory' && production ? 'deny' : whenRedisMissing;
    const memory = new Map(); // nonce -> exp (epoch ms)
    let warnedMissing = false;
    function warnMissingOnce() {
        if (warnedMissing)
            return;
        warnedMissing = true;
        const message = missingMode === 'memory'
            ? 'no Redis client: confirmation nonces are process-local (single-process dev only)'
            : whenRedisMissing === 'memory'
                ? "no Redis client and NODE_ENV=production: 'memory' is refused, write confirmations are disabled"
                : 'no Redis client: write confirmations are disabled (whenRedisMissing: deny)';
        try {
            onWarn(message);
        }
        catch {
            // A throwing logger must not change the gate's answer.
        }
    }
    function macKey() {
        const value = typeof secret === 'function' ? secret() : secret;
        if (!isNonEmptyString(value)) {
            throw new Error('[app-core/mcp] the confirmation secret is empty or not configured');
        }
        return (0, node_crypto_1.createHmac)('sha256', value).update(KEY_DERIVATION_LABEL).digest();
    }
    function sign(payload, key) {
        return (0, node_crypto_1.createHmac)('sha256', key).update(payload).digest('base64url');
    }
    const fail = (reason) => ({ ok: false, reason });
    async function storeNonce(nonce, exp) {
        if (redis) {
            try {
                await redis.set(keyPrefix + nonce, '1', { ex: ttlSeconds });
            }
            catch (error) {
                throw new ConfirmUnavailableError('Could not store the confirmation nonce', { cause: error });
            }
            return;
        }
        warnMissingOnce();
        if (missingMode === 'deny') {
            throw new ConfirmUnavailableError('No confirmation store is configured');
        }
        const at = now();
        for (const [key, expiry] of memory) {
            if (expiry < at)
                memory.delete(key);
        }
        memory.set(nonce, exp);
    }
    async function consumeNonce(nonce) {
        if (redis) {
            let deleted;
            try {
                // Atomic delete: 1 = this call consumed it, 0 = already used or expired.
                deleted = await redis.del(keyPrefix + nonce);
            }
            catch (error) {
                try {
                    onWarn(`confirmation consume failed: ${error instanceof Error ? error.message : String(error)}`);
                }
                catch {
                    // ignore logger failures
                }
                return fail('UNAVAILABLE');
            }
            return deleted === 1 ? { ok: true } : fail('ALREADY_USED');
        }
        warnMissingOnce();
        if (missingMode === 'deny')
            return fail('UNAVAILABLE');
        if (!memory.has(nonce))
            return fail('ALREADY_USED');
        memory.delete(nonce);
        return { ok: true };
    }
    async function issue(binding) {
        if (!binding || !isNonEmptyString(binding.tokenId) || !isNonEmptyString(binding.tool)) {
            throw new TypeError('[app-core/mcp] issue() needs a binding with a non-empty tokenId and tool');
        }
        const key = macKey();
        const iat = now();
        const claims = {
            v: CLAIMS_VERSION,
            tid: binding.tokenId,
            tool: binding.tool,
            ah: hashArgs(binding.args),
            n: (0, node_crypto_1.randomBytes)(NONCE_BYTES).toString('base64url'),
            iat,
            exp: iat + ttlSeconds * 1000,
        };
        const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
        const token = `${payload}.${sign(payload, key)}`;
        await storeNonce(claims.n, claims.exp);
        return { token, expiresIn: ttlSeconds };
    }
    async function verify(token, binding) {
        if (typeof token !== 'string')
            return fail('MALFORMED');
        const parts = token.split('.');
        if (parts.length !== 2 || !parts[0] || !parts[1])
            return fail('MALFORMED');
        const [payload, signature] = parts;
        if (!safeEqual(sign(payload, macKey()), signature))
            return fail('BAD_SIGNATURE');
        const claims = parseClaims(payload);
        if (!claims)
            return fail('MALFORMED');
        if (claims.tid !== binding.tokenId)
            return fail('WRONG_TOKEN');
        if (claims.tool !== binding.tool)
            return fail('WRONG_TOOL');
        if (claims.ah !== hashArgs(binding.args))
            return fail('ARGS_CHANGED');
        if (now() > claims.exp) {
            memory.delete(claims.n);
            return fail('EXPIRED');
        }
        return consumeNonce(claims.n);
    }
    function describe(reason) {
        switch (reason) {
            case 'ARGS_CHANGED':
                return 'The arguments differ from the plan that was confirmed. Call the tool again without confirmation_token to get a fresh plan.';
            case 'EXPIRED':
                return `The confirmation expired (${durationLabel(ttlSeconds)}). Call the tool again without confirmation_token to get a fresh plan.`;
            case 'ALREADY_USED':
                return 'This confirmation was already used. Each plan can be executed once; request a new plan.';
            case 'WRONG_TOOL':
            case 'WRONG_TOKEN':
                return 'This confirmation belongs to a different tool or token.';
            case 'UNAVAILABLE':
                return 'Confirmation is temporarily unavailable, so nothing was executed. Try again in a moment.';
            default:
                return 'Invalid confirmation_token. Call the tool again without it to get a plan.';
        }
    }
    return { ttlSeconds, issue, verify, describe };
}
