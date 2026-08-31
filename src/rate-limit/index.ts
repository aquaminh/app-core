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
export function createRateLimiters(
  definitions: Record<string, RateLimiterDefinition>
): RateLimitResult {
  const isRedisConfigured =
    !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

  // The map is created once and MUTATED on init so callers that grabbed the
  // reference through the getter before init still see limiters appear.
  const rateLimiters: Record<string, RateLimiterLike | null> = Object.fromEntries(
    Object.keys(definitions).map((name) => [name, null])
  );
  let initialized = false;
  let initPromise: Promise<void> | null = null;

  function buildLimiters(
    Ratelimit: typeof import('@upstash/ratelimit').Ratelimit,
    Redis: typeof import('@upstash/redis').Redis
  ): void {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });

    for (const [name, def] of Object.entries(definitions)) {
      rateLimiters[name] = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(def.limit, def.window as Parameters<typeof Ratelimit.slidingWindow>[1]),
        prefix: `ratelimit:${name}`,
      });
    }
    initialized = true;
  }

  // Async path: works in both dist formats (the ESM build has no require()).
  // Memoized so concurrent first requests share one import.
  function init(): Promise<void> {
    initPromise ??= (async () => {
      if (initialized) return;
      if (!isRedisConfigured) {
        initialized = true;
        return;
      }
      const [{ Ratelimit }, { Redis }] = await Promise.all([
        import('@upstash/ratelimit'),
        import('@upstash/redis'),
      ]);
      if (!initialized) buildLimiters(Ratelimit, Redis);
    })();
    return initPromise;
  }

  // Sync path for the `rateLimiters` getter, which predates the async init and
  // is consumed at module scope (zeebrar re-exports it). Only possible where
  // require exists: the CJS build and bundlers that shim require. Pure Node
  // ESM falls back to priming asynchronously - the mutated map fills in once
  // the import resolves; checkRateLimit() is the reliable path there.
  function initSync(): void {
    if (initialized) return;
    if (!isRedisConfigured) {
      initialized = true;
      return;
    }
    if (typeof require !== 'function') {
      void init();
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Ratelimit } = require('@upstash/ratelimit') as typeof import('@upstash/ratelimit');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Redis } = require('@upstash/redis') as typeof import('@upstash/redis');
    buildLimiters(Ratelimit, Redis);
  }

  function getClientId(request: NextRequestLike): string {
    const forwarded = request.headers.get('x-forwarded-for');
    const ip =
      forwarded?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'anonymous';
    return ip;
  }

  async function checkRateLimit(
    request: NextRequestLike,
    type: string
  ): Promise<RateLimitResponse | null> {
    await init();
    const limiter = rateLimiters[type];

    if (!limiter) return null;

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

  function withRateLimit(type: string) {
    return async function rateLimit(request: NextRequestLike): Promise<RateLimitResponse | null> {
      return checkRateLimit(request, type);
    };
  }

  return {
    get rateLimiters() {
      initSync();
      return rateLimiters;
    },
    checkRateLimit,
    getClientId,
    withRateLimit,
  };
}

// Minimal interfaces to avoid hard dependency on next/server types
interface NextRequestLike {
  headers: { get(name: string): string | null };
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
