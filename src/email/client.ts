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
  sendEmail: (options: SendEmailOptions) => Promise<{ success: boolean; id?: string; error?: string }>;
}

/**
 * Create an email client backed by Resend.
 *
 * Reads RESEND_API_KEY from env.
 * The logEmail callback is injected by the app (since it needs the app's Prisma client).
 */
export function createEmailClient(config: EmailClientConfig): EmailClient {
  let _resend: ResendLike | null = null;

  function getResendClient(): ResendLike | null {
    if (_resend) return _resend;
    if (!process.env.RESEND_API_KEY) {
      console.warn('RESEND_API_KEY not set - emails will not be sent');
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Resend } = require('resend') as typeof import('resend');
    _resend = new Resend(process.env.RESEND_API_KEY) as unknown as ResendLike;
    return _resend;
  }

  async function sendEmail(
    options: SendEmailOptions
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    const resend = getResendClient();

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
    } catch (error) {
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

// Minimal interface to avoid hard dependency on resend types
interface ResendLike {
  emails: {
    send(params: {
      from: string;
      to: string | string[];
      subject: string;
      html: string;
      text?: string;
      replyTo?: string;
    }): Promise<{
      data?: { id: string };
      error?: { message: string };
    }>;
  };
}
