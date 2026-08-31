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
exports.createRateLimiters = createRateLimiters;
/**
 * Create rate limiters backed by Upstash Redis.
 *
 * Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from env.
 * When Redis is not configured, all checks pass (dev mode).
 *
 * @param definitions - Map of limiter name to { limit, window } config.
 *   Example: { auth: { limit: 5, window: '1 m' }, api: { limit: 60, window: '1 m' } }
 */
function createRateLimiters(definitions) {
    const isRedisConfigured = !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
    // The map is created once and MUTATED on init so callers that grabbed the
    // reference through the getter before init still see limiters appear.
    const rateLimiters = Object.fromEntries(Object.keys(definitions).map((name) => [name, null]));
    let initialized = false;
    let initPromise = null;
    function buildLimiters(Ratelimit, Redis) {
        const redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        for (const [name, def] of Object.entries(definitions)) {
            rateLimiters[name] = new Ratelimit({
                redis,
                limiter: Ratelimit.slidingWindow(def.limit, def.window),
                prefix: `ratelimit:${name}`,
            });
        }
        initialized = true;
    }
    // Async path: works in both dist formats (the ESM build has no require()).
    // Memoized so concurrent first requests share one import.
    function init() {
        initPromise ??= (async () => {
            if (initialized)
                return;
            if (!isRedisConfigured) {
                initialized = true;
                return;
            }
            const [{ Ratelimit }, { Redis }] = await Promise.all([
                Promise.resolve().then(() => __importStar(require('@upstash/ratelimit'))),
                Promise.resolve().then(() => __importStar(require('@upstash/redis'))),
            ]);
            if (!initialized)
                buildLimiters(Ratelimit, Redis);
        })();
        return initPromise;
    }
    // Sync path for the `rateLimiters` getter, which predates the async init and
    // is consumed at module scope (zeebrar re-exports it). Only possible where
    // require exists: the CJS build and bundlers that shim require. Pure Node
    // ESM falls back to priming asynchronously - the mutated map fills in once
    // the import resolves; checkRateLimit() is the reliable path there.
    function initSync() {
        if (initialized)
            return;
        if (!isRedisConfigured) {
            initialized = true;
            return;
        }
        if (typeof require !== 'function') {
            void init();
            return;
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Ratelimit } = require('@upstash/ratelimit');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Redis } = require('@upstash/redis');
        buildLimiters(Ratelimit, Redis);
    }
    function getClientId(request) {
        const forwarded = request.headers.get('x-forwarded-for');
        const ip = forwarded?.split(',')[0]?.trim() ||
            request.headers.get('x-real-ip') ||
            'anonymous';
        return ip;
    }
    async function checkRateLimit(request, type) {
        await init();
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
            initSync();
            return rateLimiters;
        },
        checkRateLimit,
        getClientId,
        withRateLimit,
    };
}
