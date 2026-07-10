/**
 * EmailTransport — the actual dispatch. With no email provider configured it returns 'LOGGED'
 * (the notification is still recorded, just not sent), so the worker is fully functional without
 * secrets. Set RESEND_API_KEY (+ optional EMAIL_FROM) to dispatch real email via the Resend HTTP
 * API — no SDK/dependency needed, just fetch. Swap the URL/headers for SendGrid/SMTP-relay as needed.
 */
import { Injectable } from '@nestjs/common';

export interface SendResult {
  status: 'SENT' | 'LOGGED' | 'FAILED';
  error?: string;
}

@Injectable()
export class EmailTransport {
  private readonly apiKey = process.env.RESEND_API_KEY;
  private readonly from = process.env.EMAIL_FROM || 'alerts@rawaroma.local';

  async send(to: string | string[], subject: string, body: string, html?: string): Promise<SendResult> {
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!recipients.length) return { status: 'FAILED', error: 'no recipient' };
    // Air gap (Step 3): the factory console makes ZERO outbound calls — record only, never dispatch,
    // even if a provider key is present. (Swap for an internal SMTP relay if in-plant email is wanted.)
    if (process.env.CONSOLE === 'factory') return { status: 'LOGGED' };
    if (!this.apiKey) return { status: 'LOGGED' }; // no provider → consume + record, don't dispatch
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: recipients, subject, text: body, ...(html ? { html } : {}) }),
      });
      if (!res.ok) return { status: 'FAILED', error: `provider ${res.status}` };
      return { status: 'SENT' };
    } catch (e) {
      return { status: 'FAILED', error: (e as Error).message };
    }
  }
}
