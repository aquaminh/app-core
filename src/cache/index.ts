interface CacheClientConfig {
  enableDynamicClient?: boolean;
  /**
   * App-scoped prefix applied to every key (reads, writes, invalidations,
   * patterns), e.g. 'zeebrar:'. Makes identical logical keys collision-proof
   * when two consumers end up on the same Upstash database — which has
   * happened twice via env misconfiguration (gplc local/desktop wrote to
   * zeebrar's instance for months; launchwp prod shares gplcoffee's).
   */
  keyPrefix?: string;
}

interface CacheClient {
  getCached: <T>(key: string, fetcher: () => Promise<T>, ttlSeconds?: number) => Promise<T>;
  getCachedDynamic?: <T>(key: string, fetcher: () => Promise<T>, ttlSeconds?: number) => Promise<T>;
  invalidateCache: (key: string) => Promise<void>;
  invalidateCachePattern: (pattern: string) => Promise<void>;
}

/**
 * Envelope written around every cached value so a reader can verify the
 * value's age independently of the transport that delivered it.
 *
 * Why: the Upstash REST client runs its requests through `fetch` with
 * `cache: 'force-cache'` (required for ISR — a no-store fetch flips static
 * routes dynamic). Next.js persists those responses in its Data Cache
 * (.next/cache/fetch-cache) with NO expiry, and replays them across dev
 * restarts and ISR regenerations. Incident 2026-08-10: a zeebrar dev server
 * replayed a month-old `settings:store` response — long after both the DB row
 * and Redis had moved on — because the response was pinned on disk since
 * Jul 10. The Redis-side TTL cannot protect against that; the embedded
 * timestamp can. A replayed envelope older than the caller's ttlSeconds is
 * treated as a miss and the fetcher re-runs.
 */
interface Envelope<T> {
  __sc: 1;
  at: number; // epoch ms at write time
  data: T;
}

function isEnvelope<T>(v: unknown): v is Envelope<T> {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Envelope<T>).__sc === 1 &&
    typeof (v as Envelope<T>).at === 'number'
  );
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
export function createCacheClient(config?: CacheClientConfig): CacheClient {
  const isRedisConfigured =
    !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

  const prefix = config?.keyPrefix ?? '';
  const k = (key: string): string => prefix + key;

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

  async function readThrough<T>(
    client: RedisLike,
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds: number
  ): Promise<T> {
    try {
      const cached = await client.get<unknown>(k(key));
      if (isEnvelope<T>(cached)) {
        const age = Date.now() - cached.at;
        if (cached.data !== null && age <= ttlSeconds * 1000 + CLOCK_SKEW_GRACE_MS) {
          return cached.data;
        }
        // Too old (a replayed transport-cache response) or empty — fall
        // through to the fetcher.
      }
      // Non-envelope value (legacy v1.0.0 write) also falls through.
    } catch (error) {
      console.warn(`Cache read error for key ${k(key)}:`, error);
    }

    const fresh = await fetcher();

    const envelope: Envelope<T> = { __sc: 1, at: Date.now(), data: fresh };
    client.setex(k(key), ttlSeconds, envelope).catch((error: unknown) => {
      console.warn(`Cache write error for key ${k(key)}:`, error);
    });

    return fresh;
  }

  async function getCached<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds = 300
  ): Promise<T> {
    init();
    if (!redis) return fetcher();
    return readThrough(redis, key, fetcher, ttlSeconds);
  }

  async function getCachedDynamic<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds = 300
  ): Promise<T> {
    init();
    if (!redisDynamic) return fetcher();
    return readThrough(redisDynamic, key, fetcher, ttlSeconds);
  }

  async function invalidateCache(key: string): Promise<void> {
    init();
    const client = redisDynamic ?? redis;
    if (!client) return;

    try {
      await client.del(k(key));
    } catch (error) {
      console.warn(`Cache invalidation error for key ${k(key)}:`, error);
    }
  }

  async function invalidateCachePattern(pattern: string): Promise<void> {
    init();
    const client = redisDynamic ?? redis;
    if (!client) return;

    try {
      const keys = await client.keys(k(pattern));
      if (keys.length > 0) {
        await client.del(...keys);
      }
    } catch (error) {
      console.warn(`Cache pattern invalidation error for ${k(pattern)}:`, error);
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
