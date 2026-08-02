import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Channel, ConditionLogic, Metric, Operator } from '@app/contracts';
import { API_LIMITS } from '../../meta/limits';

export class ConditionDto {
  @IsEnum(Metric)
  metric!: Metric;

  @IsEnum(Operator)
  operator!: Operator;

  @IsNumber()
  threshold!: number;
}

export class CreateTriggerDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsString()
  @Length(1, 120)
  city!: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(API_LIMITS.maxConditionsPerTrigger)
  @ValidateNested({ each: true })
  @Type(() => ConditionDto)
  conditions!: ConditionDto[];

  @IsOptional()
  @IsEnum(ConditionLogic)
  conditionLogic?: ConditionLogic;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(API_LIMITS.maxChannelsPerTrigger)
  @IsEnum(Channel, { each: true })
  channels!: Channel[];

  @IsOptional()
  @IsInt()
  @Min(API_LIMITS.minCooldownMin)
  @Max(API_LIMITS.maxCooldownMin)
  cooldownMin?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
