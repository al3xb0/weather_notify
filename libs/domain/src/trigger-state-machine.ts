import { TriggerState } from './enums';
import { isWithinQuietHours } from './quiet-hours';

/**
 * What the watcher should do with a trigger after evaluating its conditions.
 * `SUPPRESS` means the conditions held but delivery was withheld — the reason
 * doubles as the label of the `watcher_suppressed_total` metric.
 */
export type TriggerDecision =
  | { kind: 'FIRE' }
  | { kind: 'SUPPRESS'; reason: SuppressReason }
  | { kind: 'REARM' }
  | { kind: 'NOOP' };

export type SuppressReason = 'cooldown' | 'quiet_hours';

/** The trigger fields the decision depends on — nothing more. */
export interface TriggerStateInput {
  state: TriggerState;
  lastFiredAt: Date | null;
  cooldownMin: number;
}

/** Local "HH:MM" bounds plus the IANA zone they are interpreted in. */
export interface QuietHours {
  start: string | null;
  end: string | null;
  timezone: string | null;
}

export interface ConditionsEvaluation {
  matched: boolean;
}

/**
 * Pure transition function for a single trigger. Kept free of persistence and
 * transport so the whole matrix (state × cooldown × quiet hours) is testable
 * without mocks; the caller maps the decision onto writes and publishes.
 */
export function decide(
  trigger: TriggerStateInput,
  evaluation: ConditionsEvaluation,
  now: Date,
  quietHours?: QuietHours | null,
): TriggerDecision {
  if (!evaluation.matched) {
    // Re-arm so the next crossing fires again (hysteresis).
    return trigger.state === TriggerState.FIRED
      ? { kind: 'REARM' }
      : { kind: 'NOOP' };
  }
  if (!isCooldownElapsed(trigger, now)) {
    return { kind: 'SUPPRESS', reason: 'cooldown' };
  }
  // Stay ARMED through the quiet window so it can still fire once the window
  // passes and the conditions still hold.
  if (quietHours && isInQuietHours(quietHours, now)) {
    return { kind: 'SUPPRESS', reason: 'quiet_hours' };
  }
  return { kind: 'FIRE' };
}

/**
 * Whether enough time has passed since the last delivery.
 *
 * Deliberately blind to the state, which is the fix for the hole it used to
 * have: treating ARMED as "cooldown does not apply" meant a condition that
 * cleared and came back inside the window fired again immediately, because
 * clearing it re-arms. A trigger oscillating around its threshold — the
 * ordinary case for a temperature limit, not a pathological one — delivered on
 * every poll while its owner had asked for one alert an hour.
 *
 * The two gates answer different questions and now stay separate: the state
 * machine decides whether this is a new crossing, and the cooldown decides how
 * often a crossing may be delivered. Only `lastFiredAt` can answer the second.
 */
function isCooldownElapsed(trigger: TriggerStateInput, now: Date): boolean {
  if (!trigger.lastFiredAt) {
    return true;
  }
  const elapsedMs = now.getTime() - trigger.lastFiredAt.getTime();
  return elapsedMs >= trigger.cooldownMin * 60_000;
}

function isInQuietHours(window: QuietHours, now: Date): boolean {
  return isWithinQuietHours(now, window.start, window.end, window.timezone);
}
