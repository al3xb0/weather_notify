import { ApiProperty } from '@nestjs/swagger';
import { Trigger, TriggerCondition } from '@prisma/client';
import {
  Channel,
  ConditionLogic,
  Metric,
  Operator,
  TriggerState,
} from '@app/contracts';

export class TriggerConditionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: Object.values(Metric), enumName: 'Metric' })
  metric!: Metric;

  @ApiProperty({ enum: Object.values(Operator), enumName: 'Operator' })
  operator!: Operator;

  @ApiProperty()
  threshold!: number;

  @ApiProperty({ type: 'integer', description: 'Position within the trigger' })
  order!: number;

  @ApiProperty({ type: Number, nullable: true })
  lastObservedValue!: number | null;

  @ApiProperty({ type: Boolean, nullable: true })
  lastMatched!: boolean | null;
}

export class TriggerResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  city!: string;

  @ApiProperty()
  latitude!: number;

  @ApiProperty()
  longitude!: number;

  @ApiProperty({ type: [TriggerConditionResponseDto] })
  conditions!: TriggerConditionResponseDto[];

  @ApiProperty({
    enum: Object.values(ConditionLogic),
    enumName: 'ConditionLogic',
  })
  conditionLogic!: ConditionLogic;

  @ApiProperty({
    enum: Object.values(Channel),
    enumName: 'Channel',
    isArray: true,
  })
  channels!: Channel[];

  @ApiProperty({
    type: 'integer',
    description: 'Minutes before it can re-fire',
  })
  cooldownMin!: number;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ enum: Object.values(TriggerState), enumName: 'TriggerState' })
  state!: TriggerState;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastFiredAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastEvaluatedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

type TriggerRow = Trigger & { conditions: TriggerCondition[] };

/** Row → response. `userId` and `updatedAt` stay internal. */
export function toTriggerResponse(row: TriggerRow): TriggerResponseDto {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    latitude: row.latitude,
    longitude: row.longitude,
    conditions: row.conditions.map((c) => ({
      id: c.id,
      metric: c.metric,
      operator: c.operator,
      threshold: c.threshold,
      order: c.order,
      lastObservedValue: c.lastObservedValue,
      lastMatched: c.lastMatched,
    })),
    conditionLogic: row.conditionLogic,
    channels: row.channels,
    cooldownMin: row.cooldownMin,
    isActive: row.isActive,
    state: row.state,
    lastFiredAt: row.lastFiredAt,
    lastEvaluatedAt: row.lastEvaluatedAt,
    createdAt: row.createdAt,
  };
}

export class TriggerTestResultDto {
  @ApiProperty({
    enum: Object.values(Channel),
    enumName: 'Channel',
    isArray: true,
    description: 'Channels the test event was published to',
  })
  sent!: Channel[];
}
