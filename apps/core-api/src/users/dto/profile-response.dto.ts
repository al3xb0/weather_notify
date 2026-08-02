import { ApiProperty } from '@nestjs/swagger';
import { PushSubscription, Role, User } from '@prisma/client';

export class ProfileResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ enum: Object.values(Role), enumName: 'Role' })
  role!: Role;

  @ApiProperty({ type: String, nullable: true })
  telegramChatId!: string | null;

  @ApiProperty()
  telegramLinked!: boolean;

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '22:00' })
  quietHoursStart!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '07:00' })
  quietHoursEnd!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Europe/Berlin' })
  timezone!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export function toProfileResponse(user: User): ProfileResponseDto {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    telegramChatId: user.telegramChatId,
    telegramLinked: Boolean(user.telegramChatId),
    emailVerified: user.emailVerified,
    quietHoursStart: user.quietHoursStart,
    quietHoursEnd: user.quietHoursEnd,
    timezone: user.timezone,
    createdAt: user.createdAt,
  };
}

export class TelegramLinkDto {
  @ApiProperty({ description: 'Deep link the user opens to bind their chat' })
  url!: string;

  @ApiProperty({ format: 'uuid' })
  token!: string;
}

/**
 * The subscription's `p256dh`/`auth` keys are omitted on purpose: the browser
 * already holds them and echoing them back only widens the blast radius.
 */
export class PushSubscriptionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uri' })
  endpoint!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export function toPushSubscriptionResponse(
  row: PushSubscription,
): PushSubscriptionResponseDto {
  return { id: row.id, endpoint: row.endpoint, createdAt: row.createdAt };
}
