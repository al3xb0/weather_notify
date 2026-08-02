import {
  ConditionLogic as PrismaConditionLogic,
  Metric as PrismaMetric,
  Operator as PrismaOperator,
  TriggerState as PrismaTriggerState,
} from '@prisma/client';
import { ConditionLogic, Metric, Operator, TriggerState } from '@app/domain';

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
] = [true, true, true, true];
