import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class GeocodeQueryDto {
  // Two characters is what the upstream needs to return anything useful, and
  // the cap keeps a long string from being turned into a cache key.
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q!: string;
}

export class GeocodeResultDto {
  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  country!: string | null;

  /** First-level administrative area — the state or region. */
  @ApiPropertyOptional({ nullable: true })
  admin1!: string | null;

  @ApiProperty()
  latitude!: number;

  @ApiProperty()
  longitude!: number;
}
