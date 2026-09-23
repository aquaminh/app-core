/**
 * MCP agent tokens: generate, hash, verify, create, list, revoke.
 *
 * Format: `<tokenPrefix><43 chars base64url>` (32 random bytes), e.g.
 * `gcf_mcp_...` or `zbr_mcp_...`. Only the sha256 hex of the raw token is
 * stored; a short display prefix is kept so the owner can tell tokens apart.
 * The hash is plain sha256 with no pepper, byte-identical to zeebrar's
 * original `hashMcpToken`, so tokens zeebrar already issued keep verifying.
 *
 * The package never imports @prisma/client: the app injects its McpToken
 * model delegate (`prisma.mcpToken`) through the structural
 * `McpTokenDelegateLike` slice, and every row read back is narrowed by a
 * runtime shape guard. The McpToken model itself stays in each app's schema.
 *
 * Owner rules (store match, bans, entitlement, allowlists) are NOT decided
 * here: after the hash, revocation and expiry checks pass, verify() hands the
 * row to the app's `resolvePrincipal`, so each app keeps its own semantics.
 */
import { createHash, randomBytes } from 'node:crypto';
import { extractBearer } from './bearer.js';
/** Invalid input to create()/list()/revoke(): map it to a 400, not a 500. */
export class McpTokenInputError extends Error {
    field;
    constructor(field, message) {
        super(message);
        this.name = 'McpTokenInputError';
        this.field = field;
    }
}
const TOKEN_PREFIX_PATTERN = /^[a-z]{2,8}_mcp_$/;
const RANDOM_BYTES = 32; // 43 base64url chars
const MIN_BODY_CHARS = 32; // below this after the prefix it cannot be ours; no DB call
const MAX_EXTRA_DISPLAY_CHARS = 12;
const DEFAULT_DISPLAY_EXTRA = 6;
const DEFAULT_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const NAME_MAX_LENGTH = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const DELEGATE_METHODS = ['findUnique', 'findMany', 'create', 'update', 'updateMany', 'count'];
const DEFAULT_MESSAGES = {
    MISSING: 'Authorization: Bearer <token> is required',
    MALFORMED: 'Not a valid MCP token',
    INVALID: 'Unknown token',
    REVOKED: 'This token was revoked',
    EXPIRED: 'This token has expired',
    FORBIDDEN: 'This token is not allowed to use this service',
};
function sha256Hex(raw) {
    return createHash('sha256').update(raw).digest('hex');
}
function isValidDate(value) {
    return value instanceof Date && !Number.isNaN(value.getTime());
}
function shapeError(context, field) {
    return new TypeError(`[app-core/mcp] ${context}: token row has a missing or wrong-typed "${field}" - ` +
        'pass the McpToken model delegate (prisma.mcpToken) or wrappers that return full rows');
}
/** Runtime narrowing of a delegate result. Builds a fresh object, so tokenHash never leaks out. */
function toRecord(value, context) {
    if (!value || typeof value !== 'object')
        throw shapeError(context, 'row');
    const row = value;
    for (const field of ['id', 'customerId', 'name', 'prefix']) {
        if (typeof row[field] !== 'string' || !row[field])
            throw shapeError(context, field);
    }
    if (!Array.isArray(row.scopes))
        throw shapeError(context, 'scopes');
    for (const field of ['expiresAt', 'lastUsedAt', 'revokedAt']) {
        if (row[field] !== null && !isValidDate(row[field]))
            throw shapeError(context, field);
    }
    if (!isValidDate(row.createdAt))
        throw shapeError(context, 'createdAt');
    return {
        id: row.id,
        customerId: row.customerId,
        name: row.name,
        prefix: row.prefix,
        scopes: row.scopes.filter((s) => typeof s === 'string'),
        expiresAt: row.expiresAt,
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
        createdAt: row.createdAt,
    };
}
function toListItem(record) {
    return {
        id: record.id,
        name: record.name,
        prefix: record.prefix,
        scopes: record.scopes,
        expiresAt: record.expiresAt,
        lastUsedAt: record.lastUsedAt,
        revokedAt: record.revokedAt,
        createdAt: record.createdAt,
    };
}
/**
 * A missing id must never reach a Prisma `where`: `{ customerId: undefined }`
 * means "no filter", which would turn revokeAll() into a table-wide revoke.
 */
function requireId(value, field) {
    if (typeof value !== 'string' || !value) {
        throw new McpTokenInputError(field, `${field} must be a non-empty string`);
    }
    return value;
}
function readCount(result, context) {
    const count = result?.count;
    if (typeof count !== 'number') {
        throw new TypeError(`[app-core/mcp] ${context}: updateMany did not return { count: number }`);
    }
    return count;
}
export function createMcpTokens(config) {
    if (!config || typeof config !== 'object') {
        throw new TypeError('[app-core/mcp] createMcpTokens needs a config object');
    }
    const { tokens, tokenPrefix, storeId, scopes: scopeSet, resolvePrincipal, maxExpiryDays } = config;
    if (!tokens || typeof tokens !== 'object') {
        throw new TypeError('[app-core/mcp] config.tokens must be the McpToken model delegate (prisma.mcpToken)');
    }
    for (const method of DELEGATE_METHODS) {
        if (typeof tokens[method] !== 'function') {
            throw new TypeError(`[app-core/mcp] config.tokens.${method} is not a function`);
        }
    }
    if (typeof tokenPrefix !== 'string' || !TOKEN_PREFIX_PATTERN.test(tokenPrefix)) {
        throw new TypeError(`[app-core/mcp] tokenPrefix must match ${TOKEN_PREFIX_PATTERN}, e.g. 'gcf_mcp_'`);
    }
    if (typeof storeId !== 'string' || !storeId) {
        throw new TypeError('[app-core/mcp] storeId must be a non-empty string');
    }
    if (!scopeSet || typeof scopeSet.parse !== 'function' || typeof scopeSet.is !== 'function') {
        throw new TypeError('[app-core/mcp] config.scopes must come from defineScopes()');
    }
    if (typeof resolvePrincipal !== 'function') {
        throw new TypeError('[app-core/mcp] resolvePrincipal must be a function');
    }
    if (maxExpiryDays !== null && !(Number.isInteger(maxExpiryDays) && maxExpiryDays >= 1)) {
        throw new TypeError('[app-core/mcp] maxExpiryDays must be a positive whole number of days, or null for never-expiring tokens');
    }
    const displayPrefixLength = config.displayPrefixLength ?? tokenPrefix.length + DEFAULT_DISPLAY_EXTRA;
    if (!Number.isInteger(displayPrefixLength) ||
        displayPrefixLength < tokenPrefix.length ||
        displayPrefixLength > tokenPrefix.length + MAX_EXTRA_DISPLAY_CHARS) {
        throw new TypeError(`[app-core/mcp] displayPrefixLength must be between ${tokenPrefix.length} and ${tokenPrefix.length + MAX_EXTRA_DISPLAY_CHARS}`);
    }
    const touchIntervalMs = config.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS;
    if (!Number.isFinite(touchIntervalMs) || touchIntervalMs < 0) {
        throw new TypeError('[app-core/mcp] touchIntervalMs must be a non-negative number');
    }
    const now = config.now ?? (() => new Date());
    const onError = config.onError ?? ((context, error) => console.error(`[app-core/mcp] ${context}:`, error));
    const messageFor = (error) => config.messages?.[error] || DEFAULT_MESSAGES[error];
    function report(context, error) {
        try {
            onError(context, error);
        }
        catch {
            // A throwing reporter must not turn a heartbeat into an unhandled rejection.
        }
    }
    function fail(error, customerId) {
        return {
            ok: false,
            error,
            code: error,
            message: messageFor(error),
            ...(customerId ? { customerId } : {}),
        };
    }
    function hash(raw) {
        return sha256Hex(raw);
    }
    function generate() {
        const raw = tokenPrefix + randomBytes(RANDOM_BYTES).toString('base64url');
        return { raw, prefix: raw.slice(0, displayPrefixLength), tokenHash: hash(raw) };
    }
    /** Heartbeat, throttled, fire-and-forget: never delays or fails the request. */
    function touch(record, at) {
        const last = record.lastUsedAt;
        if (last && at.getTime() - last.getTime() <= touchIntervalMs)
            return;
        try {
            tokens
                .update({ where: { id: record.id }, data: { lastUsedAt: at } })
                .then(undefined, (error) => report('lastUsedAt update failed', error));
        }
        catch (error) {
            report('lastUsedAt update failed', error);
        }
    }
    async function verify(authorization) {
        const raw = extractBearer(authorization);
        if (!raw)
            return fail('MISSING');
        if (!raw.startsWith(tokenPrefix) || raw.length < tokenPrefix.length + MIN_BODY_CHARS) {
            return fail('MALFORMED');
        }
        const found = await tokens.findUnique({ where: { tokenHash: hash(raw) } });
        if (found === null || found === undefined)
            return fail('INVALID');
        const record = toRecord(found, 'verify');
        const at = now();
        if (record.revokedAt)
            return fail('REVOKED', record.customerId);
        if (record.expiresAt && record.expiresAt.getTime() < at.getTime()) {
            return fail('EXPIRED', record.customerId);
        }
        const resolved = await resolvePrincipal({
            token: { ...record, scopes: scopeSet.parse(record.scopes) },
            storeId,
        });
        if (!resolved.ok) {
            return {
                ok: false,
                error: resolved.error,
                code: resolved.code || resolved.error,
                message: resolved.message || messageFor(resolved.error),
                customerId: record.customerId,
            };
        }
        touch(record, at);
        return { ok: true, principal: resolved.principal };
    }
    function resolveExpiry(days) {
        if (days === null) {
            if (maxExpiryDays !== null) {
                throw new McpTokenInputError('expiresInDays', `Tokens must expire within ${maxExpiryDays} days`);
            }
            return null;
        }
        if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) {
            throw new McpTokenInputError('expiresInDays', 'expiresInDays must be a whole number of days, at least 1');
        }
        if (maxExpiryDays !== null && days > maxExpiryDays) {
            throw new McpTokenInputError('expiresInDays', `Tokens must expire within ${maxExpiryDays} days`);
        }
        const expiresAt = new Date(now().getTime() + days * DAY_MS);
        if (Number.isNaN(expiresAt.getTime())) {
            throw new McpTokenInputError('expiresInDays', 'expiresInDays is out of range');
        }
        return expiresAt;
    }
    async function create(input) {
        if (!input || typeof input !== 'object') {
            throw new McpTokenInputError('customerId', 'create() needs an input object');
        }
        const customerId = requireId(input.customerId, 'customerId');
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (name.length < 1 || name.length > NAME_MAX_LENGTH) {
            throw new McpTokenInputError('name', `Token name must be 1-${NAME_MAX_LENGTH} characters`);
        }
        if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
            throw new McpTokenInputError('scopes', 'Pick at least one scope');
        }
        const unknownScopes = input.scopes.filter((scope) => !scopeSet.is(scope));
        if (unknownScopes.length > 0) {
            throw new McpTokenInputError('scopes', `Unknown scope: ${unknownScopes.join(', ')}`);
        }
        const scopes = scopeSet.parse(input.scopes);
        const expiresAt = resolveExpiry(input.expiresInDays);
        const { raw, prefix, tokenHash } = generate();
        const created = await tokens.create({
            data: { customerId, name, prefix, tokenHash, scopes, expiresAt },
        });
        return { ...toListItem(toRecord(created, 'create')), raw };
    }
    async function list(customerId) {
        const id = requireId(customerId, 'customerId');
        const rows = await tokens.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' } });
        if (!Array.isArray(rows))
            throw new TypeError('[app-core/mcp] list: findMany did not return an array');
        return rows.map((row) => toListItem(toRecord(row, 'list')));
    }
    async function countActive(customerId) {
        const id = requireId(customerId, 'customerId');
        const count = await tokens.count({
            where: {
                customerId: id,
                revokedAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: now() } }],
            },
        });
        if (typeof count !== 'number')
            throw new TypeError('[app-core/mcp] countActive: count did not return a number');
        return count;
    }
    async function revoke(customerId, tokenId) {
        const owner = requireId(customerId, 'customerId');
        const id = requireId(tokenId, 'tokenId');
        const result = await tokens.updateMany({
            where: { id, customerId: owner, revokedAt: null },
            data: { revokedAt: now() },
        });
        return readCount(result, 'revoke') === 1;
    }
    async function revokeAll(customerId) {
        const owner = requireId(customerId, 'customerId');
        const result = await tokens.updateMany({
            where: { customerId: owner, revokedAt: null },
            data: { revokedAt: now() },
        });
        return readCount(result, 'revokeAll');
    }
    return { generate, hash, verify, create, list, countActive, revoke, revokeAll };
}
//# sourceMappingURL=tokens.js.map