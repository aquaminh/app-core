interface RateLimiterDefinition {
    limit: number;
    window: string;
}
interface RateLimitResult {
    rateLimiters: Record<string, RateLimiterLike | null>;
    checkRateLimit: (request: NextRequestLike, type: string) => Promise<RateLimitResponse | null>;
    getClientId: (request: NextRequestLike) => string;
    withRateLimit: (type: string) => (request: NextRequestLike) => Promise<RateLimitResponse | null>;
}
/**
 * Create rate limiters backed by Upstash Redis.
 *
 * Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from env.
 * When Redis is not configured, all checks pass (dev mode).
 *
 * @param definitions - Map of limiter name to { limit, window } config.
 *   Example: { auth: { limit: 5, window: '1 m' }, api: { limit: 60, window: '1 m' } }
 */
export declare function createRateLimiters(definitions: Record<string, RateLimiterDefinition>): RateLimitResult;
interface NextRequestLike {
    headers: {
        get(name: string): string | null;
    };
}
interface RateLimiterLike {
    limit(identifier: string): Promise<{
        success: boolean;
        limit: number;
        remaining: number;
        reset: number;
    }>;
}
export interface RateLimitResponse {
    body: {
        error: string;
        message: string;
        retryAfter: number;
    };
    status: 429;
    headers: Record<string, string>;
}
export {};
//# sourceMappingURL=index.d.ts.map