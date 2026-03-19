export interface SendEmailOptions {
    to: string | string[];
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    template?: string;
    customerId?: string;
    metadata?: Record<string, unknown>;
}
export interface EmailLogParams {
    to: string | string[];
    subject: string;
    template?: string;
    status: 'sent' | 'failed' | 'skipped';
    resendId?: string;
    error?: string;
    customerId?: string;
    metadata?: Record<string, unknown>;
}
interface EmailClientConfig {
    fromEmail: string;
    supportEmail: string;
    logEmail: (params: EmailLogParams) => Promise<void>;
}
interface EmailClient {
    sendEmail: (options: SendEmailOptions) => Promise<{
        success: boolean;
        id?: string;
        error?: string;
    }>;
}
/**
 * Create an email client backed by Resend.
 *
 * Reads RESEND_API_KEY from env.
 * The logEmail callback is injected by the app (since it needs the app's Prisma client).
 */
export declare function createEmailClient(config: EmailClientConfig): EmailClient;
export {};
//# sourceMappingURL=client.d.ts.map