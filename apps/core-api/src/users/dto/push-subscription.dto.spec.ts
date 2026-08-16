import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreatePushSubscriptionDto } from './push-subscription.dto';

const dtoFor = (endpoint: string) =>
  plainToInstance(CreatePushSubscriptionDto, {
    endpoint,
    keys: { p256dh: 'p', auth: 'a' },
  });

const errorsFor = (endpoint: string) => validateSync(dtoFor(endpoint));

describe('CreatePushSubscriptionDto', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc123',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://sea1.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/QWERTY',
  ])('accepts %s', (endpoint) => {
    expect(errorsFor(endpoint)).toHaveLength(0);
  });

  it.each([
    // The notifier POSTs to this URL — an arbitrary host makes that an SSRF.
    'https://internal.corp/admin',
    'https://169.254.169.254/latest/meta-data',
    'http://fcm.googleapis.com/fcm/send/abc',
    // Suffix tricks around the allow-list.
    'https://fcm.googleapis.com.attacker.tld/send',
    'https://notfcm.googleapis.com/send',
    'https://evilpush.apple.com/x',
  ])('rejects %s', (endpoint) => {
    expect(errorsFor(endpoint).length).toBeGreaterThan(0);
  });
});
