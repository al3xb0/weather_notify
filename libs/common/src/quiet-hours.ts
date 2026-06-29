/**
 * Whether `now` falls inside the user's quiet-hours window, given local "HH:MM"
 * bounds interpreted in the supplied IANA timezone. Supports windows that wrap
 * past midnight (e.g. 22:00 → 07:00). Returns false when any bound is missing or
 * malformed, or the window is empty (start === end).
 */
export function isWithinQuietHours(
  now: Date,
  start: string | null | undefined,
  end: string | null | undefined,
  timezone: string | null | undefined,
): boolean {
  if (!start || !end) {
    return false;
  }
  const startMin = parseHHMM(start);
  const endMin = parseHHMM(end);
  if (startMin === null || endMin === null || startMin === endMin) {
    return false;
  }
  const nowMin = localMinutes(now, timezone);
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Window wraps past midnight.
  return nowMin >= startMin || nowMin < endMin;
}

function parseHHMM(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) {
    return null;
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

function localMinutes(now: Date, timezone: string | null | undefined): number {
  const parts = formatParts(now, timezone || 'UTC');
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const min = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // Intl can emit "24" for midnight in some runtimes; normalize to 0..23.
  return (h % 24) * 60 + min;
}

function formatParts(now: Date, timeZone: string): Intl.DateTimeFormatPart[] {
  const opts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  try {
    return new Intl.DateTimeFormat('en-US', {
      ...opts,
      timeZone,
    }).formatToParts(now);
  } catch {
    // Defensive fallback for legacy/invalid zones already stored in the DB.
    return new Intl.DateTimeFormat('en-US', {
      ...opts,
      timeZone: 'UTC',
    }).formatToParts(now);
  }
}
