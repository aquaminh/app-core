/**
 * Create a cache client backed by Upstash Redis.
 *
 * Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from env.
 * Degrades gracefully (returns fetcher result directly) when Redis is not configured.
 *
 * @param config.enableDynamicClient - Create a second Redis client with no-store cache
 *   for mutable data that must reflect admin changes immediately.
 */
export function createCacheClient(config) {
    const isRedisConfigured = !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
    // Lazy-import to keep @upstash/redis optional
    let redis = null;
    let redisDynamic = null;
    let initialized = false;
    function init() {
        if (initialized)
            return;
        initialized = true;
        if (!isRedisConfigured)
            return;
        // Dynamic import isn't practical here (sync factory), so we require at call time.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Redis } = require('@upstash/redis');
        redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
            cache: 'force-cache',
        });
        if (config?.enableDynamicClient) {
            redisDynamic = new Redis({
                url: process.env.UPSTASH_REDIS_REST_URL,
                token: process.env.UPSTASH_REDIS_REST_TOKEN,
                cache: 'no-store',
            });
        }
    }
    async function getCached(key, fetcher, ttlSeconds = 300) {
        init();
        if (!redis)
            return fetcher();
        try {
            const cached = await redis.get(key);
            if (cached !== null)
                return cached;
        }
        catch (error) {
            console.warn(`Cache read error for key ${key}:`, error);
        }
        const fresh = await fetcher();
        redis.setex(key, ttlSeconds, fresh).catch((error) => {
            console.warn(`Cache write error for key ${key}:`, error);
        });
        return fresh;
    }
    async function getCachedDynamic(key, fetcher, ttlSeconds = 300) {
        init();
        if (!redisDynamic)
            return fetcher();
        try {
            const cached = await redisDynamic.get(key);
            if (cached !== null)
                return cached;
        }
        catch (error) {
            console.warn(`Cache read error for key ${key}:`, error);
        }
        const fresh = await fetcher();
        redisDynamic.setex(key, ttlSeconds, fresh).catch((error) => {
            console.warn(`Cache write error for key ${key}:`, error);
        });
        return fresh;
    }
    async function invalidateCache(key) {
        init();
        const client = redisDynamic ?? redis;
        if (!client)
            return;
        try {
            await client.del(key);
        }
        catch (error) {
            console.warn(`Cache invalidation error for key ${key}:`, error);
        }
    }
    async function invalidateCachePattern(pattern) {
        init();
        const client = redisDynamic ?? redis;
        if (!client)
            return;
        try {
            const keys = await client.keys(pattern);
            if (keys.length > 0) {
                await client.del(...keys);
            }
        }
        catch (error) {
            console.warn(`Cache pattern invalidation error for ${pattern}:`, error);
        }
    }
    const result = {
        getCached,
        invalidateCache,
        invalidateCachePattern,
    };
    if (config?.enableDynamicClient) {
        result.getCachedDynamic = getCachedDynamic;
    }
    return result;
}
//# sourceMappingURL=index.js.map