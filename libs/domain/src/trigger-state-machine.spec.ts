import { TriggerState } from './enums';
import {
  decide,
  QuietHours,
  TriggerDecision,
  TriggerStateInput,
} from './trigger-state-machine';

const NOW = new Date('2026-06-28T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

/** 09:00–17:00 UTC contains NOW; 22:00–07:00 wraps midnight and does not. */
const DAYTIME: QuietHours = {
  start: '09:00',
  end: '17:00',
  timezone: 'UTC',
};
const OVERNIGHT: QuietHours = {
  start: '22:00',
  end: '07:00',
  timezone: 'UTC',
};

type Case = {
  name: string;
  trigger: Partial<TriggerStateInput>;
  matched: boolean;
  quietHours?: QuietHours | null;
  expected: TriggerDecision;
};

function trigger(
  overrides: Partial<TriggerStateInput> = {},
): TriggerStateInput {
  return {
    state: TriggerState.ARMED,
    lastFiredAt: null,
    cooldownMin: 30,
    ...overrides,
  };
}

const cases: Case[] = [
  // ── Conditions not met ────────────────────────────────────────────────────
  {
    name: 'ARMED and unmatched stays put',
    trigger: { state: TriggerState.ARMED },
    matched: false,
    expected: { kind: 'NOOP' },
  },
  {
    name: 'FIRED and unmatched re-arms (hysteresis)',
    trigger: { state: TriggerState.FIRED, lastFiredAt: minutesAgo(1) },
    matched: false,
    expected: { kind: 'REARM' },
  },
  {
    name: 'unmatched re-arms even inside quiet hours',
    trigger: { state: TriggerState.FIRED, lastFiredAt: minutesAgo(1) },
    matched: false,
    quietHours: DAYTIME,
    expected: { kind: 'REARM' },
  },
  {
    name: 'unmatched ignores an unelapsed cooldown',
    trigger: { state: TriggerState.FIRED, lastFiredAt: NOW, cooldownMin: 60 },
    matched: false,
    expected: { kind: 'REARM' },
  },

  // ── Conditions met, cooldown gate ─────────────────────────────────────────
  {
    name: 'ARMED fires regardless of a recent lastFiredAt',
    trigger: { state: TriggerState.ARMED, lastFiredAt: NOW, cooldownMin: 60 },
    matched: true,
    expected: { kind: 'FIRE' },
  },
  {
    name: 'FIRED inside its cooldown is suppressed',
    trigger: {
      state: TriggerState.FIRED,
      lastFiredAt: minutesAgo(29),
      cooldownMin: 30,
    },
    matched: true,
    expected: { kind: 'SUPPRESS', reason: 'cooldown' },
  },
  {
    name: 'FIRED exactly at the cooldown boundary fires',
    trigger: {
      state: TriggerState.FIRED,
      lastFiredAt: minutesAgo(30),
      cooldownMin: 30,
    },
    matched: true,
    expected: { kind: 'FIRE' },
  },
  {
    name: 'FIRED past its cooldown fires again',
    trigger: {
      state: TriggerState.FIRED,
      lastFiredAt: minutesAgo(31),
      cooldownMin: 30,
    },
    matched: true,
    expected: { kind: 'FIRE' },
  },
  {
    name: 'FIRED without a lastFiredAt fires rather than waiting forever',
    trigger: { state: TriggerState.FIRED, lastFiredAt: null },
    matched: true,
    expected: { kind: 'FIRE' },
  },

  // ── Conditions met, quiet-hours gate ──────────────────────────────────────
  {
    name: 'quiet hours suppress a would-be firing',
    trigger: { state: TriggerState.ARMED },
    matched: true,
    quietHours: DAYTIME,
    expected: { kind: 'SUPPRESS', reason: 'quiet_hours' },
  },
  {
    name: 'a window that does not contain now lets it fire',
    trigger: { state: TriggerState.ARMED },
    matched: true,
    quietHours: OVERNIGHT,
    expected: { kind: 'FIRE' },
  },
  {
    name: 'no window configured lets it fire',
    trigger: { state: TriggerState.ARMED },
    matched: true,
    quietHours: null,
    expected: { kind: 'FIRE' },
  },
  {
    name: 'a half-configured window is ignored',
    trigger: { state: TriggerState.ARMED },
    matched: true,
    quietHours: { start: '09:00', end: null, timezone: 'UTC' },
    expected: { kind: 'FIRE' },
  },
  {
    name: 'cooldown is reported ahead of quiet hours when both apply',
    trigger: {
      state: TriggerState.FIRED,
      lastFiredAt: minutesAgo(1),
      cooldownMin: 30,
    },
    matched: true,
    quietHours: DAYTIME,
    expected: { kind: 'SUPPRESS', reason: 'cooldown' },
  },
];

describe('decide', () => {
  it.each(cases)(
    '$name',
    ({ trigger: overrides, matched, quietHours, expected }) => {
      expect(decide(trigger(overrides), { matched }, NOW, quietHours)).toEqual(
        expected,
      );
    },
  );

  it('reads quiet hours in the trigger owner timezone, not UTC', () => {
    // 12:00 UTC is 08:00 in New York — outside a 09:00–17:00 local window.
    expect(
      decide(trigger(), { matched: true }, NOW, {
        start: '09:00',
        end: '17:00',
        timezone: 'America/New_York',
      }),
    ).toEqual({ kind: 'FIRE' });
  });

  it('never suppresses without also being able to name a reason', () => {
    for (const c of cases) {
      const decision = decide(
        trigger(c.trigger),
        { matched: c.matched },
        NOW,
        c.quietHours,
      );
      if (decision.kind === 'SUPPRESS') {
        expect(['cooldown', 'quiet_hours']).toContain(decision.reason);
      }
    }
  });
});
