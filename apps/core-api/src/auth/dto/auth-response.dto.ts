import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';

/** The refresh token travels in an httpOnly cookie, never in the body. */
export class AuthResponseDto {
  @ApiProperty({ description: 'Short-lived JWT for the Authorization header' })
  accessToken!: string;
}

export class AuthUserDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ enum: Object.values(Role), enumName: 'Role' })
  role!: Role;
}

export class VerifyEmailResultDto {
  @ApiProperty()
  verified!: boolean;
}

export class ResendVerificationResultDto {
  @ApiProperty()
  sent!: boolean;
}
