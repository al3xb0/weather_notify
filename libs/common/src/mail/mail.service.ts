import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

/**
 * Thin Resend wrapper shared by the notifier (alert emails) and core-api
 * (verification emails). Becomes a no-op sender when RESEND_API_KEY is unset.
 */
@Injectable()
export class MailService {
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY') ?? '';
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.from = config.get<string>('RESEND_FROM') ?? 'alerts@example.com';
  }

  get configured(): boolean {
    return this.resend !== null;
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.resend) {
      throw new Error('RESEND_API_KEY is not set');
    }
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
    });
    if (error) {
      throw new Error(`Resend error: ${error.message}`);
    }
  }
}
