/**
 * Unified cron authentication for all scheduled routes.
 *
 * Supports two auth methods:
 *   1. Bearer token (GET) — for manual testing and simple cron callers
 *   2. QStash signature (POST) — for Upstash QStash scheduled jobs
 *
 * Reads CRON_SECRET, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY from env.
 */
export interface CronAuthResult {
    authorized: boolean;
    method: 'bearer' | 'qstash' | 'none';
}
interface RequestLike {
    headers: {
        get(name: string): string | null;
    };
}
export declare function verifyCronAuth(request: RequestLike, body?: string): Promise<CronAuthResult>;
export {};
//# sourceMappingURL=auth.d.ts.map