/**
 * Every limit the API enforces, in one place and served over `GET /meta`.
 *
 * These were previously scattered across services and re-declared by hand in
 * the frontend, where one had already drifted: the dashboard offered a "max 20"
 * button against a server limit of 10, so the button stayed enabled and the API
 * answered 400.
 */
export const API_LIMITS = {
  maxTriggersPerUser: 10,
  maxConditionsPerTrigger: 5,
  maxPinnedCities: 12,
  /** Seconds a user must wait between test sends, across all their triggers. */
  testCooldownSec: 600,
  minCooldownMin: 10,
  maxCooldownMin: 1440,
  maxChannelsPerTrigger: 3,
} as const;

export type ApiLimits = typeof API_LIMITS;
