import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsNumber } from 'class-validator';

export class ForecastQueryDto {
  // Query strings arrive as text; the transform is what makes the numeric
  // range checks below mean anything.
  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  latitude!: number;

  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  longitude!: number;
}

export class CurrentWeatherDto {
  @ApiProperty()
  time!: string;

  @ApiProperty()
  temperature!: number;

  @ApiProperty()
  apparentTemp!: number;

  @ApiProperty()
  humidity!: number;

  @ApiProperty()
  windSpeed!: number;

  @ApiProperty()
  precipitation!: number;

  @ApiProperty()
  weatherCode!: number;
}

export class DailyForecastDto {
  @ApiProperty()
  date!: string;

  @ApiProperty()
  weatherCode!: number;

  @ApiProperty()
  tempMax!: number;

  @ApiProperty()
  tempMin!: number;

  @ApiPropertyOptional({ nullable: true })
  precipitationProbability!: number | null;
}

export class ForecastResponseDto {
  @ApiProperty({ type: CurrentWeatherDto })
  current!: CurrentWeatherDto;

  @ApiProperty({ type: [DailyForecastDto] })
  daily!: DailyForecastDto[];
}
