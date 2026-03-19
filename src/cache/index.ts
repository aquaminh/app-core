interface CacheClientConfig {
  enableDynamicClient?: boolean;
}

interface CacheClient {
  getCached: <T>(key: string, fetcher: () => Promise<T>, ttlSeconds?: number) => Promise<T>;
  getCachedDynamic?: <T>(key: string, fetcher: () => Promise<T>, ttlSeconds?: number) => Promise<T>;
  invalidateCache: (key: string) => Promise<void>;
  invalidateCachePattern: (pattern: string) => Promise<void>;
}

/**
 * Create a cache client backed by Upstash Redis.
 *
 * Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from env.
 * Degrades gracefully (returns fetcher result directly) when Redis is not configured.
 *
 * @param config.enableDynamicClient - Create a second Redis client with no-store cache
 *   for mutable data that must reflect admin changes immediately.
 */
export function createCacheClient(config?: CacheClientConfig): CacheClient {
  const isRedisConfigured =
    !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

  // Lazy-import to keep @upstash/redis optional
  let redis: RedisLike | null = null;
  let redisDynamic: RedisLike | null = null;
  let initialized = false;

  function init(): void {
    if (initialized) return;
    initialized = true;

    if (!isRedisConfigured) return;

    // Dynamic import isn't practical here (sync factory), so we require at call time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Redis } = require('@upstash/redis') as typeof import('@upstash/redis');

    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      cache: 'force-cache',
    }) as RedisLike;

    if (config?.enableDynamicClient) {
      redisDynamic = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
        cache: 'no-store',
      }) as RedisLike;
    }
  }

  async function getCached<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds = 300
  ): Promise<T> {
    init();
    if (!redis) return fetcher();

    try {
      const cached = await redis.get<T>(key);
      if (cached !== null) return cached;
    } catch (error) {
      console.warn(`Cache read error for key ${key}:`, error);
    }

    const fresh = await fetcher();

    redis.setex(key, ttlSeconds, fresh).catch((error: unknown) => {
      console.warn(`Cache write error for key ${key}:`, error);
    });

    return fresh;
  }

  async function getCachedDynamic<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds = 300
  ): Promise<T> {
    init();
    if (!redisDynamic) return fetcher();

    try {
      const cached = await redisDynamic.get<T>(key);
      if (cached !== null) return cached;
    } catch (error) {
      console.warn(`Cache read error for key ${key}:`, error);
    }

    const fresh = await fetcher();

    redisDynamic.setex(key, ttlSeconds, fresh).catch((error: unknown) => {
      console.warn(`Cache write error for key ${key}:`, error);
    });

    return fresh;
  }

  async function invalidateCache(key: string): Promise<void> {
    init();
    const client = redisDynamic ?? redis;
    if (!client) return;

    try {
      await client.del(key);
    } catch (error) {
      console.warn(`Cache invalidation error for key ${key}:`, error);
    }
  }

  async function invalidateCachePattern(pattern: string): Promise<void> {
    init();
    const client = redisDynamic ?? redis;
    if (!client) return;

    try {
      const keys = await client.keys(pattern);
      if (keys.length > 0) {
        await client.del(...keys);
      }
    } catch (error) {
      console.warn(`Cache pattern invalidation error for ${pattern}:`, error);
    }
  }

  const result: CacheClient = {
    getCached,
    invalidateCache,
    invalidateCachePattern,
  };

  if (config?.enableDynamicClient) {
    result.getCachedDynamic = getCachedDynamic;
  }

  return result;
}

// Minimal interface to avoid hard dependency on @upstash/redis types
interface RedisLike {
  get<T>(key: string): Promise<T | null>;
  setex(key: string, ttl: number, value: unknown): Promise<string>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}
