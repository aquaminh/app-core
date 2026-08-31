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
exports.createEmailClient = createEmailClient;
/**
 * Create an email client backed by Resend.
 *
 * Reads RESEND_API_KEY from env.
 * The logEmail callback is injected by the app (since it needs the app's Prisma client).
 */
function createEmailClient(config) {
    // Memoized so concurrent first sends share one import; dynamic import keeps
    // resend an optional peer and works in both dist formats (the ESM build has
    // no require()).
    let _resendPromise = null;
    function getResendClient() {
        _resendPromise ??= (async () => {
            if (!process.env.RESEND_API_KEY) {
                console.warn('RESEND_API_KEY not set - emails will not be sent');
                return null;
            }
            const { Resend } = await Promise.resolve().then(() => __importStar(require('resend')));
            return new Resend(process.env.RESEND_API_KEY);
        })();
        return _resendPromise;
    }
    async function sendEmail(options) {
        const resend = await getResendClient();
        if (!resend) {
            console.log('[Email] Skipping send (no API key):', options.subject);
            await config.logEmail({
                to: options.to,
                subject: options.subject,
                template: options.template,
                status: 'skipped',
                error: 'No API key configured',
                customerId: options.customerId,
                metadata: options.metadata,
            });
            return { success: false, error: 'No API key configured' };
        }
        try {
            const result = await resend.emails.send({
                from: config.fromEmail,
                to: options.to,
                subject: options.subject,
                html: options.html,
                text: options.text,
                replyTo: options.replyTo || config.supportEmail,
            });
            if (result.error) {
                console.error('[Email] Send failed:', result.error);
                await config.logEmail({
                    to: options.to,
                    subject: options.subject,
                    template: options.template,
                    status: 'failed',
                    error: result.error.message,
                    customerId: options.customerId,
                    metadata: options.metadata,
                });
                return { success: false, error: result.error.message };
            }
            await config.logEmail({
                to: options.to,
                subject: options.subject,
                template: options.template,
                status: 'sent',
                resendId: result.data?.id,
                customerId: options.customerId,
                metadata: options.metadata,
            });
            return { success: true, id: result.data?.id };
        }
        catch (error) {
            console.error('[Email] Send error:', error);
            const errorMessage = error instanceof Error ? error.message : 'Failed to send email';
            await config.logEmail({
                to: options.to,
                subject: options.subject,
                template: options.template,
                status: 'failed',
                error: errorMessage,
                customerId: options.customerId,
                metadata: options.metadata,
            });
            return { success: false, error: 'Failed to send email' };
        }
    }
    return { sendEmail };
}
