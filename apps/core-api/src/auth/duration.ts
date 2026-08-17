/**
 * Parse a JWT-style duration string (e.g. "15m", "7d") into milliseconds.
 *
 * Lives here rather than inside `AuthService` because the access-token
 * lifetime is now needed in a second place: revoking a deleted account's
 * tokens uses it as the TTL of the deny marker, and the two must agree — a
 * shorter TTL would let a token outlive its own revocation.
 */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid JWT duration "${value}" — expected a value like "15m" or "7d"`,
    );
  }
  const amount = Number(match[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]!;
  return amount * unit;
}

export const DEFAULT_ACCESS_TTL = '15m';
