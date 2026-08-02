/**
 * The domain owns its own vocabulary instead of importing Prisma's generated
 * enums — that is what keeps `libs/domain` free of the ORM. Shapes mirror what
 * Prisma emits (const object + literal union), so both sides stay structurally
 * assignable; `libs/database` asserts that equality at compile time.
 */

export const Metric = {
  TEMPERATURE: 'TEMPERATURE',
  APPARENT_TEMP: 'APPARENT_TEMP',
  WIND_SPEED: 'WIND_SPEED',
  PRECIPITATION: 'PRECIPITATION',
  HUMIDITY: 'HUMIDITY',
  SEVERE: 'SEVERE',
} as const;
export type Metric = (typeof Metric)[keyof typeof Metric];

export const Operator = {
  GT: 'GT',
  GTE: 'GTE',
  LT: 'LT',
  LTE: 'LTE',
  EQ: 'EQ',
} as const;
export type Operator = (typeof Operator)[keyof typeof Operator];

export const ConditionLogic = {
  AND: 'AND',
  OR: 'OR',
} as const;
export type ConditionLogic =
  (typeof ConditionLogic)[keyof typeof ConditionLogic];

export const TriggerState = {
  ARMED: 'ARMED',
  FIRED: 'FIRED',
} as const;
export type TriggerState = (typeof TriggerState)[keyof typeof TriggerState];
