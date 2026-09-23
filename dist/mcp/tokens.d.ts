import type { ScopeSet } from './scopes.js';
export interface McpTokenRecord {
    id: string;
    customerId: string;
    name: string;
    prefix: string;
    scopes: string[];
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
}
/** What list()/create() return: never tokenHash, never customerId. */
export type McpTokenListItem = Omit<McpTokenRecord, 'customerId'>;
/**
 * Structural slice of a Prisma model delegate (the app passes prisma.mcpToken).
 * Results are typed `unknown` and narrowed by a runtime guard inside the module,
 * so the package never imports @prisma/client or a generated type. If a future
 * Prisma version stops being structurally assignable, the app passes arrow
 * wrappers instead ({ findUnique: (a) => prisma.mcpToken.findUnique(a), ... }).
 * Wrappers must return full rows: a row missing a field fails closed.
 */
export interface McpTokenDelegateLike {
    findUnique(args: {
        where: {
            tokenHash: string;
        };
    }): PromiseLike<unknown>;
    findMany(args: {
        where: {
            customerId: string;
        };
        orderBy: {
            createdAt: 'desc';
        };
    }): PromiseLike<unknown[]>;
    create(args: {
        data: {
            customerId: string;
            name: string;
            prefix: string;
            tokenHash: string;
            scopes: string[];
            expiresAt: Date | null;
        };
    }): PromiseLike<unknown>;
    update(args: {
        where: {
            id: string;
        };
        data: {
            lastUsedAt: Date;
        };
    }): PromiseLike<unknown>;
    updateMany(args: {
        where: {
            id?: string;
            customerId: string;
            revokedAt: null;
        };
        data: {
            revokedAt: Date;
        };
    }): PromiseLike<{
        count: number;
    }>;
    count(args: {
        where: {
            customerId: string;
            revokedAt: null;
            OR: Array<{
                expiresAt: null;
            } | {
                expiresAt: {
                    gt: Date;
                };
            }>;
        };
    }): PromiseLike<number>;
}
export interface McpPrincipalBase<S extends string> {
    tokenId: string;
    customerId: string;
    scopes: S[];
    expiresAt: Date | null;
}
export type McpAuthError = 'MISSING' | 'MALFORMED' | 'INVALID' | 'REVOKED' | 'EXPIRED' | 'FORBIDDEN';
export type McpAuthResult<P> = {
    ok: true;
    principal: P;
}
/** customerId is set whenever the token row was found (REVOKED/EXPIRED/FORBIDDEN), so the app can decide stealth vs explicit errors. */
 | {
    ok: false;
    error: McpAuthError;
    code: string;
    message: string;
    customerId?: string;
};
export type McpResolveResult<P> = {
    ok: true;
    principal: P;
} | {
    ok: false;
    error: 'INVALID' | 'REVOKED' | 'FORBIDDEN';
    code: string;
    message: string;
};
export interface CreateMcpTokensConfig<S extends string, P extends McpPrincipalBase<S>> {
    tokens: McpTokenDelegateLike;
    /** 'gcf_mcp_' (gplcoffee) | 'zbr_mcp_' (zeebrar). Must match /^[a-z]{2,8}_mcp_$/. */
    tokenPrefix: string;
    /** Handed to resolvePrincipal; the owner-row check lives there because each app's Customer shape differs. */
    storeId: string;
    scopes: ScopeSet<S>;
    /** App business rules: store match, bans, entitlement, allowlist. Called only after hash/revoked/expired pass. */
    resolvePrincipal(ctx: {
        token: McpTokenRecord & {
            scopes: S[];
        };
        storeId: string;
    }): Promise<McpResolveResult<P>>;
    /** Default tokenPrefix.length + 6 (zeebrar: 14). Allowed range: tokenPrefix.length .. tokenPrefix.length + 12. */
    displayPrefixLength?: number;
    /** Minimum gap between lastUsedAt writes. Default 3_600_000 (one hour). */
    touchIntervalMs?: number;
    /** create() rejects a longer expiry; null allows never-expiring tokens (zeebrar keeps null, gplcoffee passes 365). Required. */
    maxExpiryDays: number | null;
    /** App copy per error, e.g. where the token UI lives. */
    messages?: Partial<Record<McpAuthError, string>>;
    /** Test seam. */
    now?: () => Date;
    /** Default console.error. Receives the fire-and-forget lastUsedAt failures. */
    onError?: (context: string, error: unknown) => void;
}
export interface McpTokens<S extends string, P> {
    generate(): {
        raw: string;
        prefix: string;
        tokenHash: string;
    };
    /** Plain sha256 hex of the raw token. Byte-identical to zeebrar's hashMcpToken so live zeebrar tokens keep verifying. No pepper. */
    hash(raw: string): string;
    verify(authorization: string | null | undefined): Promise<McpAuthResult<P>>;
    /** Returns the raw token exactly once; only its hash is stored. Throws McpTokenInputError on invalid input. */
    create(input: {
        customerId: string;
        name: string;
        scopes: S[];
        expiresInDays: number | null;
    }): Promise<McpTokenListItem & {
        raw: string;
    }>;
    list(customerId: string): Promise<McpTokenListItem[]>;
    /** Live tokens: not revoked and not expired. */
    countActive(customerId: string): Promise<number>;
    /** Revoke one of the customer's live tokens. False when it is not theirs or already revoked. */
    revoke(customerId: string, tokenId: string): Promise<boolean>;
    /** Kill switch for ban, password change, account deletion. Returns rows revoked. */
    revokeAll(customerId: string): Promise<number>;
}
export type McpTokenInputField = 'customerId' | 'tokenId' | 'name' | 'scopes' | 'expiresInDays';
/** Invalid input to create()/list()/revoke(): map it to a 400, not a 500. */
export declare class McpTokenInputError extends Error {
    readonly field: McpTokenInputField;
    constructor(field: McpTokenInputField, message: string);
}
export declare function createMcpTokens<S extends string, P extends McpPrincipalBase<S>>(config: CreateMcpTokensConfig<S, P>): McpTokens<S, P>;
//# sourceMappingURL=tokens.d.ts.map