import { ApiProperty } from '@nestjs/swagger';
import { PinnedCity } from '@prisma/client';

export class PinnedCityResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  country!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Region or state' })
  admin1!: string | null;

  @ApiProperty()
  latitude!: number;

  @ApiProperty()
  longitude!: number;

  @ApiProperty({ type: 'integer' })
  order!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export function toPinnedCityResponse(row: PinnedCity): PinnedCityResponseDto {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    admin1: row.admin1,
    latitude: row.latitude,
    longitude: row.longitude,
    order: row.order,
    createdAt: row.createdAt,
  };
}
