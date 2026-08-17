import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  // Same bounds as registration: bcrypt ignores everything past the 72nd byte,
  // so a longer password would silently be truncated rather than rejected.
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}
