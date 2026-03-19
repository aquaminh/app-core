/**
 * Create rate limiters backed by Upstash Redis.
 *
 * Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from env.
 * When Redis is not configured, all checks pass (dev mode).
 *
 * @param definitions - Map of limiter name to { limit, window } config.
 *   Example: { auth: { limit: 5, window: '1 m' }, api: { limit: 60, window: '1 m' } }
 */
export function createRateLimiters(definitions) {
    const isRedisConfigured = !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
    let rateLimiters = {};
    let initialized = false;
    function init() {
        if (initialized)
            return;
        initialized = true;
        if (!isRedisConfigured) {
            rateLimiters = Object.fromEntries(Object.keys(definitions).map((name) => [name, null]));
            return;
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Ratelimit } = require('@upstash/ratelimit');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Redis } = require('@upstash/redis');
        const redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        rateLimiters = Object.fromEntries(Object.entries(definitions).map(([name, def]) => [
            name,
            new Ratelimit({
                redis,
                limiter: Ratelimit.slidingWindow(def.limit, def.window),
                prefix: `ratelimit:${name}`,
            }),
        ]));
    }
    function getClientId(request) {
        const forwarded = request.headers.get('x-forwarded-for');
        const ip = forwarded?.split(',')[0]?.trim() ||
            request.headers.get('x-real-ip') ||
            'anonymous';
        return ip;
    }
    async function checkRateLimit(request, type) {
        init();
        const limiter = rateLimiters[type];
        if (!limiter)
            return null;
        const clientId = getClientId(request);
        const result = await limiter.limit(clientId);
        if (!result.success) {
            return {
                body: {
                    error: 'Too many requests',
                    message: 'Please try again later',
                    retryAfter: Math.ceil((result.reset - Date.now()) / 1000),
                },
                status: 429,
                headers: {
                    'X-RateLimit-Limit': result.limit.toString(),
                    'X-RateLimit-Remaining': result.remaining.toString(),
                    'X-RateLimit-Reset': result.reset.toString(),
                    'Retry-After': Math.ceil((result.reset - Date.now()) / 1000).toString(),
                },
            };
        }
        return null;
    }
    function withRateLimit(type) {
        return async function rateLimit(request) {
            return checkRateLimit(request, type);
        };
    }
    return {
        get rateLimiters() {
            init();
            return rateLimiters;
        },
        checkRateLimit,
        getClientId,
        withRateLimit,
    };
}
//# sourceMappingURL=index.js.map