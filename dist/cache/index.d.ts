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
export declare function createCacheClient(config?: CacheClientConfig): CacheClient;
export {};
//# sourceMappingURL=index.d.ts.map