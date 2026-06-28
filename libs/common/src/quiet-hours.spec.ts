import { isWithinQuietHours } from './quiet-hours';

describe('isWithinQuietHours', () => {
  const at = (iso: string) => new Date(iso);

  it('returns false when either bound is missing', () => {
    expect(isWithinQuietHours(at('2026-06-28T12:00:00Z'), null, '07:00', 'UTC')).toBe(false);
    expect(isWithinQuietHours(at('2026-06-28T12:00:00Z'), '22:00', null, 'UTC')).toBe(false);
  });

  it('returns false for malformed bounds or an empty window', () => {
    expect(isWithinQuietHours(at('2026-06-28T12:00:00Z'), '9:00', '17:00', 'UTC')).toBe(false);
    expect(isWithinQuietHours(at('2026-06-28T12:00:00Z'), '25:00', '17:00', 'UTC')).toBe(false);
    expect(isWithinQuietHours(at('2026-06-28T12:00:00Z'), '09:00', '09:00', 'UTC')).toBe(false);
  });

  it('handles a same-day window', () => {
    expect(isWithinQuietHours(at('2026-06-28T12:00:00Z'), '09:00', '17:00', 'UTC')).toBe(true);
    expect(isWithinQuietHours(at('2026-06-28T08:00:00Z'), '09:00', '17:00', 'UTC')).toBe(false);
    // End is exclusive.
    expect(isWithinQuietHours(at('2026-06-28T17:00:00Z'), '09:00', '17:00', 'UTC')).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(isWithinQuietHours(at('2026-06-28T23:00:00Z'), '22:00', '07:00', 'UTC')).toBe(true);
    expect(isWithinQuietHours(at('2026-06-28T03:00:00Z'), '22:00', '07:00', 'UTC')).toBe(true);
    expect(isWithinQuietHours(at('2026-06-28T12:00:00Z'), '22:00', '07:00', 'UTC')).toBe(false);
  });

  it('interprets the bounds in the given timezone', () => {
    // 23:30 UTC is inside 22:00–07:00, but only 19:30 in New York (UTC-4 DST).
    const instant = at('2026-06-28T23:30:00Z');
    expect(isWithinQuietHours(instant, '22:00', '07:00', 'UTC')).toBe(true);
    expect(isWithinQuietHours(instant, '22:00', '07:00', 'America/New_York')).toBe(false);
  });
});
