import { IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreatePinnedCityDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  country?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  admin1?: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;
}
