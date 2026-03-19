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
export declare function createCacheClient(config?: CacheClientConfig): CacheClient;
export {};
//# sourceMappingURL=index.d.ts.map