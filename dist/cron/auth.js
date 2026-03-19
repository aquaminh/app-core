/**
 * Unified cron authentication for all scheduled routes.
 *
 * Supports two auth methods:
 *   1. Bearer token (GET) — for manual testing and simple cron callers
 *   2. QStash signature (POST) — for Upstash QStash scheduled jobs
 *
 * Reads CRON_SECRET, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY from env.
 */
let _receiver = null;
let _receiverInitialized = false;
function getReceiver() {
    if (_receiverInitialized)
        return _receiver;
    _receiverInitialized = true;
    if (!process.env.QSTASH_CURRENT_SIGNING_KEY || !process.env.QSTASH_NEXT_SIGNING_KEY) {
        return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Receiver } = require('@upstash/qstash');
    _receiver = new Receiver({
        currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
        nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
    });
    return _receiver;
}
export async function verifyCronAuth(request, body) {
    // Method 1: Bearer token (typically GET requests or manual calls)
    const authHeader = request.headers.get('authorization');
    if (authHeader === `Bearer ${process.env.CRON_SECRET}`) {
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
            }
            catch {
                // Signature verification failed — fall through to unauthorized
            }
        }
    }
    return { authorized: false, method: 'none' };
}
//# sourceMappingURL=auth.js.map