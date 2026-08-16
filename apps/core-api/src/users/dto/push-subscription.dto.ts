import { Type } from 'class-transformer';
import {
  IsString,
  IsUrl,
  registerDecorator,
  ValidateNested,
  type ValidationOptions,
} from 'class-validator';

/**
 * Hosts that actually operate a Web Push service. The notifier POSTs to
 * whatever endpoint is stored here, so an unconstrained URL turns that request
 * into an SSRF primitive pointed wherever the caller likes — https and a public
 * TLD narrow it, but they do not stop `https://internal.corp/admin`.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

function isKnownPushHost(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Suffix match on a dot boundary: `evil-push.apple.com.attacker.tld` and
  // `notpush.apple.com` must both miss.
  return PUSH_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

function IsPushServiceEndpoint(options?: ValidationOptions) {
  return (object: object, propertyName: string): void =>
    registerDecorator({
      name: 'isPushServiceEndpoint',
      target: object.constructor,
      propertyName,
      options: {
        message: 'endpoint must be issued by a known push service',
        ...options,
      },
      validator: { validate: isKnownPushHost },
    });
}

class PushKeysDto {
  @IsString()
  p256dh!: string;

  @IsString()
  auth!: string;
}

export class CreatePushSubscriptionDto {
  // Push services always issue https endpoints; the host allow-list above is
  // what keeps the notifier's POST from being aimed anywhere else.
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @IsPushServiceEndpoint()
  endpoint!: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;
}

export class DeletePushSubscriptionDto {
  @IsString()
  endpoint!: string;
}
