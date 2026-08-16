import { Logger } from '@nestjs/common';
import { installRejectionGuard } from './rejection-guard';

describe('installRejectionGuard', () => {
  let logged: string[];
  let before: unknown[];

  beforeEach(() => {
    logged = [];
    before = process.listeners('unhandledRejection');
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
  });

  afterEach(() => {
    // Leave the process exactly as found: a listener surviving the suite would
    // silently swallow rejections in every file that runs after this one.
    for (const listener of process.listeners('unhandledRejection')) {
      if (!before.includes(listener)) {
        process.off('unhandledRejection', listener);
      }
    }
    jest.restoreAllMocks();
  });

  const fire = (reason: unknown): void => {
    const listeners = process.listeners('unhandledRejection');
    const added = listeners[listeners.length - 1];
    added(reason, Promise.resolve());
  };

  it('logs a rejected Error with its stack rather than letting Node exit', () => {
    installRejectionGuard('Notifier');

    fire(new Error('postgres is away'));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('postgres is away');
    // The stack is the whole point: an unhandled rejection has no other
    // context, so a bare message leaves nothing to find the caller by.
    expect(logged[0]).toContain('rejection-guard.spec.ts');
  });

  it('survives a rejection that is not an Error', () => {
    installRejectionGuard('Watcher');

    expect(() => fire('just a string')).not.toThrow();
    expect(logged[0]).toContain('just a string');
  });

  it('registers a listener so the default terminate-on-rejection never runs', () => {
    const started = process.listenerCount('unhandledRejection');

    installRejectionGuard('CoreApi');

    expect(process.listenerCount('unhandledRejection')).toBe(started + 1);
  });
});
