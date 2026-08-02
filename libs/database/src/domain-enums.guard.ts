import {
  Channel as PrismaChannel,
  ConditionLogic as PrismaConditionLogic,
  Metric as PrismaMetric,
  NotifStatus as PrismaNotifStatus,
  Operator as PrismaOperator,
  TriggerState as PrismaTriggerState,
} from '@prisma/client';
import {
  Channel,
  ConditionLogic,
  Metric,
  NotifStatus,
  Operator,
  TriggerState,
} from '@app/domain';

/** Mutual assignability — `never` (and thus a compile error) on any drift. */
type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

/**
 * The domain declares these enums and the schema must follow. Adding a value on
 * either side alone breaks the build here instead of at runtime — the database
 * layer is where the two vocabularies meet, so the check belongs here rather
 * than in the domain.
 */
export const DOMAIN_ENUMS_MATCH_PRISMA: [
  AssertEqual<Metric, PrismaMetric>,
  AssertEqual<Operator, PrismaOperator>,
  AssertEqual<ConditionLogic, PrismaConditionLogic>,
  AssertEqual<TriggerState, PrismaTriggerState>,
  AssertEqual<Channel, PrismaChannel>,
  AssertEqual<NotifStatus, PrismaNotifStatus>,
] = [true, true, true, true, true, true];
