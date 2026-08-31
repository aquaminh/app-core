"use strict";
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
exports.createCacheClient = createCacheClient;
function isEnvelope(v) {
    return (typeof v === 'object' &&
        v !== null &&
        v.__sc === 1 &&
        typeof v.at === 'number');
}
// Grace added to the age check so minor clock skew between writer and reader
// instances doesn't cause spurious misses. A premature miss is only an extra
// DB read — correctness never depends on this value.
const CLOCK_SKEW_GRACE_MS = 5_000;
/**
 * Create a cache client backed by Upstash Redis.
 *
 * Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from env.
 * Degrades gracefully (returns fetcher result directly) when Redis is not
 * configured.
 *
 * Values are stored inside a timestamped envelope (see Envelope above);
 * legacy non-envelope values from v1.0.0 are treated as misses and rewritten
 * in the new format on first read — no migration needed.
 *
 * @param config.enableDynamicClient - Create a second Redis client with
 *   no-store cache for mutable data that must reflect admin changes
 *   immediately.
 * @param config.keyPrefix - App-scoped prefix applied to every key.
 */
function createCacheClient(config) {
    const isRedisConfigured = !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
    const prefix = config?.keyPrefix ?? '';
    const k = (key) => prefix + key;
    // Lazy-import to keep @upstash/redis optional
    let redis = null;
    let redisDynamic = null;
    let initPromise = null;
    // Memoized so concurrent first calls share one import instead of the second
    // caller seeing a half-initialized state.
    function init() {
        initPromise ??= (async () => {
            if (!isRedisConfigured)
                return;
            // Dynamic import keeps @upstash/redis optional AND works in both dist
            // formats - the ESM build has no require(), the CJS build compiles this
            // to one.
            const { Redis } = await Promise.resolve().then(() => __importStar(require('@upstash/redis')));
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
        })();
        return initPromise;
    }
    async function readThrough(client, key, fetcher, ttlSeconds) {
        try {
            const cached = await client.get(k(key));
            if (isEnvelope(cached)) {
                const age = Date.now() - cached.at;
                if (cached.data !== null && age <= ttlSeconds * 1000 + CLOCK_SKEW_GRACE_MS) {
                    return cached.data;
                }
                // Too old (a replayed transport-cache response) or empty — fall
                // through to the fetcher.
            }
            // Non-envelope value (legacy v1.0.0 write) also falls through.
        }
        catch (error) {
            console.warn(`Cache read error for key ${k(key)}:`, error);
        }
        const fresh = await fetcher();
        const envelope = { __sc: 1, at: Date.now(), data: fresh };
        client.setex(k(key), ttlSeconds, envelope).catch((error) => {
            console.warn(`Cache write error for key ${k(key)}:`, error);
        });
        return fresh;
    }
    async function getCached(key, fetcher, ttlSeconds = 300) {
        await init();
        if (!redis)
            return fetcher();
        return readThrough(redis, key, fetcher, ttlSeconds);
    }
    async function getCachedDynamic(key, fetcher, ttlSeconds = 300) {
        await init();
        if (!redisDynamic)
            return fetcher();
        return readThrough(redisDynamic, key, fetcher, ttlSeconds);
    }
    async function invalidateCache(key) {
        await init();
        const client = redisDynamic ?? redis;
        if (!client)
            return;
        try {
            await client.del(k(key));
        }
        catch (error) {
            console.warn(`Cache invalidation error for key ${k(key)}:`, error);
        }
    }
    async function invalidateCachePattern(pattern) {
        await init();
        const client = redisDynamic ?? redis;
        if (!client)
            return;
        try {
            const keys = await client.keys(k(pattern));
            if (keys.length > 0) {
                await client.del(...keys);
            }
        }
        catch (error) {
            console.warn(`Cache pattern invalidation error for ${k(pattern)}:`, error);
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
