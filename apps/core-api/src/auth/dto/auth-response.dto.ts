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

/**
 * Deliberately says nothing about whether the address exists. The endpoint is
 * unauthenticated, so a response that differed between a known and an unknown
 * email would turn it into an account-enumeration oracle.
 */
export class ForgotPasswordResultDto {
  @ApiProperty({
    description:
      'Always true — the response is identical for known and unknown addresses',
  })
  accepted!: boolean;
}

export class ResetPasswordResultDto {
  @ApiProperty()
  reset!: boolean;
}
