import {
  Channel,
  ConditionLogic,
  ConditionSpec,
  QuietHours,
  TriggerState,
} from '@app/domain';

/** DI token for trigger persistence — see `PrismaWatchedTriggerRepository`. */
export const WATCHED_TRIGGER_REPOSITORY = Symbol('WATCHED_TRIGGER_REPOSITORY');

export interface WatchedCondition extends ConditionSpec {
  id: string;
}

/**
 * The projection the poll cycle works with. Deliberately narrower than the
 * `Trigger` row: the quiet-hours window arrives already flattened off the user,
 * and nothing the watcher never reads (timestamps, audit columns) is present.
 */
export interface WatchedTrigger {
  id: string;
  userId: string;
  name: string;
  city: string;
  latitude: number;
  longitude: number;
  conditionLogic: ConditionLogic;
  conditions: WatchedCondition[];
  channels: Channel[];
  cooldownMin: number;
  state: TriggerState;
  lastFiredAt: Date | null;
  quietHours: QuietHours | null;
}

export interface ConditionObservation {
  id: string;
  observedValue: number;
  matched: boolean;
}

/** Trigger-level fields a cycle may write. `state` moves only on REARM/FIRE. */
export interface TriggerStatePatch {
  lastEvaluatedAt: Date;
  state?: TriggerState;
  lastFiredAt?: Date;
}

export interface WatchedTriggerRepository {
  findActive(): Promise<WatchedTrigger[]>;
  /** Persist the per-condition observations and the state patch atomically. */
  recordObservation(
    triggerId: string,
    observations: ConditionObservation[],
    patch: TriggerStatePatch,
  ): Promise<void>;
}
