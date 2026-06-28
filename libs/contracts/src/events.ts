import { Channel, Metric, Operator } from '@prisma/client';

/**
 * Event published by the watcher to RabbitMQ when a trigger's condition is met.
 * Consumed by the notifier, fanned out to the enabled channels.
 */
export interface TriggerFiredEvent {
  eventId: string;
  triggerId: string;
  userId: string;
  triggerName: string;
  city: string;
  metric: Metric;
  operator: Operator;
  threshold: number;
  observedValue: number;
  channels: Channel[];
  firedAt: string;
  /** True when published by the user-initiated "send test" action. */
  test?: boolean;
}
