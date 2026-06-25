import {
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
} from 'class-validator';
import { Channel, Metric, Operator } from '@app/contracts';

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

  @IsEnum(Metric)
  metric!: Metric;

  @IsEnum(Operator)
  operator!: Operator;

  @IsNumber()
  threshold!: number;

  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(Channel, { each: true })
  channels!: Channel[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  cooldownMin?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
