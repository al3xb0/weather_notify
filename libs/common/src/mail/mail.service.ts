import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

/**
 * Thin SMTP wrapper (Nodemailer) shared by the notifier (alert emails) and
 * core-api (verification emails). Becomes a no-op sender when SMTP_HOST is
 * unset, so any free SMTP provider (Gmail, Brevo, Mailtrap, …) can back it.
 */
@Injectable()
export class MailService {
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST') ?? '';
    this.from = config.get<string>('MAIL_FROM') ?? 'alerts@example.com';
    if (!host) {
      this.transporter = null;
      return;
    }
    const port = Number(config.get<string>('SMTP_PORT') ?? '587');
    const user = config.get<string>('SMTP_USER') ?? '';
    const pass = config.get<string>('SMTP_PASS') ?? '';
    this.transporter = createTransport({
      host,
      port,
      // 465 implies implicit TLS; 587/others upgrade via STARTTLS.
      secure: config.get<string>('SMTP_SECURE') === 'true' || port === 465,
      auth: user ? { user, pass } : undefined,
    });
  }

  get configured(): boolean {
    return this.transporter !== null;
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      throw new Error('SMTP is not configured (SMTP_HOST is unset)');
    }
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
    });
  }
}
