import { IsIn, IsOptional, Matches, ValidateIf } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// Validate against the runtime's IANA tz database so a bad zone can never reach
// Intl.DateTimeFormat in the watcher (which would throw a RangeError).
const TIMEZONES = Intl.supportedValuesOf('timeZone');

export class UpdateProfileDto {
  // null clears the window; a string must be HH:MM (24h).
  @IsOptional()
  @Matches(HHMM, { message: 'quietHoursStart must be HH:MM' })
  quietHoursStart?: string | null;

  @IsOptional()
  @Matches(HHMM, { message: 'quietHoursEnd must be HH:MM' })
  quietHoursEnd?: string | null;

  // null clears the zone (treated as UTC); otherwise must be a valid IANA name.
  @IsOptional()
  @ValidateIf((o: UpdateProfileDto) => o.timezone !== null)
  @IsIn(TIMEZONES, { message: 'timezone must be a valid IANA name' })
  timezone?: string | null;
}
