import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdateProfileDto {
  // null clears the window; a string must be HH:MM (24h).
  @IsOptional()
  @Matches(HHMM, { message: 'quietHoursStart must be HH:MM' })
  quietHoursStart?: string | null;

  @IsOptional()
  @Matches(HHMM, { message: 'quietHoursEnd must be HH:MM' })
  quietHoursEnd?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string | null;
}
