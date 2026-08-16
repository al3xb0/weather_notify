/** DI token for recipient lookups — see `PrismaRecipientsRepository`. */
export const RECIPIENTS_REPOSITORY = Symbol('RECIPIENTS_REPOSITORY');

export interface EmailRecipient {
  email: string | null;
  verified: boolean;
}

export interface PushRecipient {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Where a channel finds the address it delivers to. Channels state what they
 * need in their own terms — a chat id, a verified mailbox, this browser's
 * subscriptions — and stay out of how any of it is stored.
 */
export interface RecipientsRepository {
  telegramChatId(userId: string): Promise<string | null>;
  emailRecipient(userId: string): Promise<EmailRecipient | null>;
  pushSubscriptions(userId: string): Promise<PushRecipient[]>;
  /** Drop a subscription the push service reported as gone. */
  removePushSubscription(id: string): Promise<void>;
}
