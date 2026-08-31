/**
 * Unified cron authentication for all scheduled routes.
 *
 * Supports two auth methods:
 *   1. Bearer token (GET) — for manual testing and simple cron callers
 *   2. QStash signature (POST) — for Upstash QStash scheduled jobs
 *
 * Reads CRON_SECRET, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY from env.
 */

import { timingSafeEqual } from 'node:crypto';

export interface CronAuthResult {
  authorized: boolean;
  method: 'bearer' | 'qstash' | 'none';
}

// Minimal interface to avoid hard dependency on next/server
interface RequestLike {
  headers: { get(name: string): string | null };
}

let _receiver: ReceiverLike | null = null;
let _receiverInitialized = false;

function getReceiver(): ReceiverLike | null {
  if (_receiverInitialized) return _receiver;
  _receiverInitialized = true;

  if (!process.env.QSTASH_CURRENT_SIGNING_KEY || !process.env.QSTASH_NEXT_SIGNING_KEY) {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Receiver } = require('@upstash/qstash') as typeof import('@upstash/qstash');
  _receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
  }) as unknown as ReceiverLike;

  return _receiver;
}

let _warnedMissingSecret = false;

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function verifyCronAuth(
  request: RequestLike,
  body?: string
): Promise<CronAuthResult> {
  // Method 1: Bearer token (typically GET requests or manual calls).
  // Guard against an unset CRON_SECRET — without it, the literal header
  // "Bearer undefined" would authenticate on any deployment missing the env var.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret && !_warnedMissingSecret) {
    _warnedMissingSecret = true;
    // Misconfiguration, not an auth failure: name the env var so a deployment
    // missing it doesn't 401 every cron route with no pointer to the cause.
    console.warn('[app-core/cron] CRON_SECRET is not set - Bearer cron auth is disabled');
  }
  const authHeader = request.headers.get('authorization');
  if (cronSecret && authHeader && safeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return { authorized: true, method: 'bearer' };
  }

  // Method 2: QStash signature (POST requests from Upstash)
  const receiver = getReceiver();
  if (receiver) {
    const signature = request.headers.get('upstash-signature');
    if (signature) {
      try {
        const isValid = await receiver.verify({
          signature,
          body: body ?? '',
        });
        if (isValid) {
          return { authorized: true, method: 'qstash' };
        }
      } catch {
        // Signature verification failed — fall through to unauthorized
      }
    }
  }

  return { authorized: false, method: 'none' };
}

interface ReceiverLike {
  verify(params: { signature: string; body: string }): Promise<boolean>;
}
