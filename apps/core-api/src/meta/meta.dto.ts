import { ApiProperty } from '@nestjs/swagger';

/**
 * Server-enforced limits, so clients can disable a control before the user
 * hits a 400 rather than duplicating the numbers and drifting from them.
 */
export class ApiLimitsDto {
  @ApiProperty({ type: 'integer' })
  maxTriggersPerUser!: number;

  @ApiProperty({ type: 'integer' })
  maxConditionsPerTrigger!: number;

  @ApiProperty({ type: 'integer' })
  maxPinnedCities!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Seconds between test sends, counted per user not per trigger',
  })
  testCooldownSec!: number;

  @ApiProperty({ type: 'integer' })
  minCooldownMin!: number;

  @ApiProperty({ type: 'integer' })
  maxCooldownMin!: number;

  @ApiProperty({ type: 'integer' })
  maxChannelsPerTrigger!: number;
}

export class MetaResponseDto {
  @ApiProperty({ type: ApiLimitsDto })
  limits!: ApiLimitsDto;
}
