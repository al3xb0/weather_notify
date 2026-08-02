import { ApiProperty } from '@nestjs/swagger';
import { Notification } from '@prisma/client';
import { Channel, NotifStatus } from '@app/contracts';

export class NotificationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null once the originating trigger has been deleted',
  })
  triggerId!: string | null;

  @ApiProperty({ enum: Object.values(Channel), enumName: 'Channel' })
  channel!: Channel;

  @ApiProperty({ enum: Object.values(NotifStatus), enumName: 'NotifStatus' })
  status!: NotifStatus;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The fired event as delivered — shape follows TriggerFiredEvent',
  })
  payload!: unknown;

  @ApiProperty({ type: String, nullable: true })
  error!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/** Row → response. `userId` stays internal; it is always the caller. */
export function toNotificationResponse(
  row: Notification,
): NotificationResponseDto {
  return {
    id: row.id,
    triggerId: row.triggerId,
    channel: row.channel,
    status: row.status,
    payload: row.payload,
    error: row.error,
    createdAt: row.createdAt,
  };
}
