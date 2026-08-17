import {
  Channel,
  ConditionLogic,
  ConditionSpec,
  QuietHours,
  TriggerState,
} from '@app/domain';
import type { TriggerFiredEvent } from '@app/contracts';

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

/** One outbound delivery, staged in the same transaction as the state change. */
export interface OutboxMessage {
  eventId: string;
  routingKey: string;
  event: TriggerFiredEvent;
}

export interface WatchedTriggerRepository {
  /**
   * Active triggers in the given location buckets.
   *
   * The restriction is an argument rather than a filter the caller applies
   * afterwards, because it has to reach the database. Reading every active
   * trigger and keeping the ones this instance owns made the read cost grow
   * with the number of instances — each one scanning the whole table to
   * discard most of it — which is the opposite of what sharding is for.
   *
   * Omitted means all of them, which is the single-instance deployment.
   */
  findActive(buckets?: number[]): Promise<WatchedTrigger[]>;
  /** Persist the per-condition observations and the state patch atomically. */
  recordObservation(
    triggerId: string,
    observations: ConditionObservation[],
    patch: TriggerStatePatch,
  ): Promise<void>;
  /**
   * The same write, plus the events the firing owes the broker, in one
   * transaction. Publishing first and committing second would re-fire the
   * trigger under a fresh eventId after a crash in between — a duplicate the
   * consumer cannot recognise, because its claim is keyed on that id.
   */
  commitFire(
    triggerId: string,
    observations: ConditionObservation[],
    patch: TriggerStatePatch,
    messages: OutboxMessage[],
  ): Promise<void>;
}
