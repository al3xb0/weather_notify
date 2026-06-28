import { Channel, ConditionLogic, Metric, Operator } from '@prisma/client';

/** A single evaluated condition carried in a fired event. */
export interface FiredCondition {
  metric: Metric;
  operator: Operator;
  threshold: number;
  observedValue: number;
}

/**
 * Event published by the watcher to RabbitMQ when a trigger's conditions are
 * met. Consumed by the notifier, fanned out to the enabled channels.
 */
export interface TriggerFiredEvent {
  eventId: string;
  triggerId: string;
  userId: string;
  triggerName: string;
  city: string;
  conditions: FiredCondition[];
  conditionLogic: ConditionLogic;
  channels: Channel[];
  firedAt: string;
  /** True when published by the user-initiated "send test" action. */
  test?: boolean;
}
