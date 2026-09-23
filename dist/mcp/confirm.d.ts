export interface ConfirmRedisLike {
    set(key: string, value: string, opts: {
        ex: number;
    }): Promise<unknown>;
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
export type ConfirmationFailure = 'MALFORMED' | 'BAD_SIGNATURE' | 'WRONG_TOKEN' | 'WRONG_TOOL' | 'ARGS_CHANGED' | 'EXPIRED' | 'ALREADY_USED' | 'UNAVAILABLE';
export type ConfirmationCheck = {
    ok: true;
} | {
    ok: false;
    reason: ConfirmationFailure;
};
/** The nonce store is missing (under 'deny') or failed. Nothing was issued. */
export declare class ConfirmUnavailableError extends Error {
    constructor(message?: string, options?: {
        cause?: unknown;
    });
}
export interface ConfirmGate {
    readonly ttlSeconds: number;
    /** Phase 1. Throws ConfirmUnavailableError when Redis is missing under 'deny' or the SET fails. */
    issue(binding: ConfirmBinding): Promise<{
        token: string;
        expiresIn: number;
    }>;
    /** Phase 2: verify AND consume. ok exactly once per token. Mismatches do NOT consume. */
    verify(token: string, binding: ConfirmBinding): Promise<ConfirmationCheck>;
    describe(reason: ConfirmationFailure): string;
}
/**
 * Stable JSON: object keys sorted, undefined (and function/symbol) members
 * dropped, so { a, b } and { b, a } hash identically. Array holes and
 * undefined elements encode as null, and a top-level undefined as 'null',
 * matching JSON.stringify.
 */
export declare function canonicalJson(value: unknown): string;
/** sha256 hex of canonicalJson(args). */
export declare function hashArgs(args: unknown): string;
export declare function createConfirmGate(config: ConfirmGateConfig): ConfirmGate;
//# sourceMappingURL=confirm.d.ts.map