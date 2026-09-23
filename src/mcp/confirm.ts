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
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface ConfirmRedisLike {
  set(key: string, value: string, opts: { ex: number }): Promise<unknown>;
  del(key: string): Promise<number>;
}

export interface ConfirmGateConfig {
  /** MUST be a no-store client (see the module docblock). null when Redis is not configured. */
  redis: ConfirmRedisLike | null;
  /** Read lazily so a missing env throws at first use, not at import. */
  secret: string | (() => string);
  /** e.g. 'gplcoffee:mcp:confirm:' / 'zeebrar:mcp:confirm:' */
  keyPrefix: string;
  /** Default 300. */
  ttlSeconds?: number;
  /**
   * Required, no default: the app states its topology. 'memory' is for
   * single-process dev only and is treated as 'deny' under NODE_ENV=production.
   */
  whenRedisMissing: 'memory' | 'deny';
  /** Epoch milliseconds. Test seam. */
  now?: () => number;
  /** Default console.warn. */
  onWarn?: (message: string) => void;
}

export interface ConfirmBinding {
  tokenId: string;
  tool: string;
  args: unknown;
}

export type ConfirmationFailure =
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'WRONG_TOKEN'
  | 'WRONG_TOOL'
  | 'ARGS_CHANGED'
  | 'EXPIRED'
  | 'ALREADY_USED'
  | 'UNAVAILABLE';

export type ConfirmationCheck = { ok: true } | { ok: false; reason: ConfirmationFailure };

/** The nonce store is missing (under 'deny') or failed. Nothing was issued. */
export class ConfirmUnavailableError extends Error {
  constructor(message = 'Confirmation store is unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfirmUnavailableError';
  }
}

export interface ConfirmGate {
  readonly ttlSeconds: number;
  /** Phase 1. Throws ConfirmUnavailableError when Redis is missing under 'deny' or the SET fails. */
  issue(binding: ConfirmBinding): Promise<{ token: string; expiresIn: number }>;
  /** Phase 2: verify AND consume. ok exactly once per token. Mismatches do NOT consume. */
  verify(token: string, binding: ConfirmBinding): Promise<ConfirmationCheck>;
  describe(reason: ConfirmationFailure): string;
}

const KEY_DERIVATION_LABEL = 'app-core:mcp-confirm:v1';
const CLAIMS_VERSION = 1;
const NONCE_BYTES = 16;
const DEFAULT_TTL_SECONDS = 300;

interface Claims {
  v: typeof CLAIMS_VERSION;
  tid: string;
  tool: string;
  ah: string;
  n: string;
  iat: number;
  exp: number;
}

function encode(input: unknown): string | undefined {
  let value = input;
  // Mirror JSON.stringify: honour toJSON (so Dates bind by value, not as {}).
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (Array.isArray(value)) return `[${value.map((item) => encode(item) ?? 'null').join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries: Array<[string, string]> = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const encoded = encode(item);
      if (encoded !== undefined) entries.push([key, encoded]);
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
export function canonicalJson(value: unknown): string {
  return encode(value) ?? 'null';
}

/** sha256 hex of canonicalJson(args). */
export function hashArgs(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseClaims(payload: string): Claims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const c = parsed as Record<string, unknown>;
  if (c.v !== CLAIMS_VERSION) return null;
  if (!isNonEmptyString(c.tid) || !isNonEmptyString(c.tool) || !isNonEmptyString(c.ah) || !isNonEmptyString(c.n)) {
    return null;
  }
  if (typeof c.iat !== 'number' || !Number.isFinite(c.iat) || typeof c.exp !== 'number' || !Number.isFinite(c.exp)) {
    return null;
  }
  return c as unknown as Claims;
}

function durationLabel(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${seconds} seconds`;
}

export function createConfirmGate(config: ConfirmGateConfig): ConfirmGate {
  if (!config || typeof config !== 'object') {
    throw new TypeError('[app-core/mcp] createConfirmGate needs a config object');
  }
  const { secret, keyPrefix, whenRedisMissing } = config;
  if (whenRedisMissing !== 'memory' && whenRedisMissing !== 'deny') {
    throw new TypeError(
      "[app-core/mcp] whenRedisMissing is required: 'deny' (production) or 'memory' (single-process dev only)"
    );
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
  const onWarn = config.onWarn ?? ((message: string) => console.warn(`[app-core/mcp] ${message}`));
  const production = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
  const missingMode: 'memory' | 'deny' = whenRedisMissing === 'memory' && production ? 'deny' : whenRedisMissing;

  const memory = new Map<string, number>(); // nonce -> exp (epoch ms)
  let warnedMissing = false;

  function warnMissingOnce(): void {
    if (warnedMissing) return;
    warnedMissing = true;
    const message =
      missingMode === 'memory'
        ? 'no Redis client: confirmation nonces are process-local (single-process dev only)'
        : whenRedisMissing === 'memory'
          ? "no Redis client and NODE_ENV=production: 'memory' is refused, write confirmations are disabled"
          : 'no Redis client: write confirmations are disabled (whenRedisMissing: deny)';
    try {
      onWarn(message);
    } catch {
      // A throwing logger must not change the gate's answer.
    }
  }

  function macKey(): Buffer {
    const value = typeof secret === 'function' ? secret() : secret;
    if (!isNonEmptyString(value)) {
      throw new Error('[app-core/mcp] the confirmation secret is empty or not configured');
    }
    return createHmac('sha256', value).update(KEY_DERIVATION_LABEL).digest();
  }

  function sign(payload: string, key: Buffer): string {
    return createHmac('sha256', key).update(payload).digest('base64url');
  }

  const fail = (reason: ConfirmationFailure): ConfirmationCheck => ({ ok: false, reason });

  async function storeNonce(nonce: string, exp: number): Promise<void> {
    if (redis) {
      try {
        await redis.set(keyPrefix + nonce, '1', { ex: ttlSeconds });
      } catch (error) {
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
      if (expiry < at) memory.delete(key);
    }
    memory.set(nonce, exp);
  }

  async function consumeNonce(nonce: string): Promise<ConfirmationCheck> {
    if (redis) {
      let deleted: unknown;
      try {
        // Atomic delete: 1 = this call consumed it, 0 = already used or expired.
        deleted = await redis.del(keyPrefix + nonce);
      } catch (error) {
        try {
          onWarn(`confirmation consume failed: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // ignore logger failures
        }
        return fail('UNAVAILABLE');
      }
      return deleted === 1 ? { ok: true } : fail('ALREADY_USED');
    }
    warnMissingOnce();
    if (missingMode === 'deny') return fail('UNAVAILABLE');
    if (!memory.has(nonce)) return fail('ALREADY_USED');
    memory.delete(nonce);
    return { ok: true };
  }

  async function issue(binding: ConfirmBinding): Promise<{ token: string; expiresIn: number }> {
    if (!binding || !isNonEmptyString(binding.tokenId) || !isNonEmptyString(binding.tool)) {
      throw new TypeError('[app-core/mcp] issue() needs a binding with a non-empty tokenId and tool');
    }
    const key = macKey();
    const iat = now();
    const claims: Claims = {
      v: CLAIMS_VERSION,
      tid: binding.tokenId,
      tool: binding.tool,
      ah: hashArgs(binding.args),
      n: randomBytes(NONCE_BYTES).toString('base64url'),
      iat,
      exp: iat + ttlSeconds * 1000,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${payload}.${sign(payload, key)}`;
    await storeNonce(claims.n, claims.exp);
    return { token, expiresIn: ttlSeconds };
  }

  async function verify(token: string, binding: ConfirmBinding): Promise<ConfirmationCheck> {
    if (typeof token !== 'string') return fail('MALFORMED');
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return fail('MALFORMED');
    const [payload, signature] = parts;

    if (!safeEqual(sign(payload, macKey()), signature)) return fail('BAD_SIGNATURE');

    const claims = parseClaims(payload);
    if (!claims) return fail('MALFORMED');
    if (claims.tid !== binding.tokenId) return fail('WRONG_TOKEN');
    if (claims.tool !== binding.tool) return fail('WRONG_TOOL');
    if (claims.ah !== hashArgs(binding.args)) return fail('ARGS_CHANGED');
    if (now() > claims.exp) {
      memory.delete(claims.n);
      return fail('EXPIRED');
    }
    return consumeNonce(claims.n);
  }

  function describe(reason: ConfirmationFailure): string {
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
