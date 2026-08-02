import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { TriggerResponseDto } from '../../triggers/dto/trigger-response.dto';

export class AdminStatsDto {
  @ApiProperty({ type: 'integer' }) users!: number;
  @ApiProperty({ type: 'integer' }) verifiedUsers!: number;
  @ApiProperty({ type: 'integer' }) admins!: number;
  @ApiProperty({ type: 'integer' }) triggers!: number;
  @ApiProperty({ type: 'integer' }) activeTriggers!: number;
  @ApiProperty({ type: 'integer' }) pinnedCities!: number;
  @ApiProperty({ type: 'integer' }) notifications!: number;
  @ApiProperty({ type: 'integer' }) notificationsSent!: number;
  @ApiProperty({ type: 'integer' }) notificationsFailed!: number;
}

export class AdminUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ enum: Object.values(Role), enumName: 'Role' })
  role!: Role;

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty()
  telegramLinked!: boolean;

  @ApiProperty({ type: 'integer' })
  triggerCount!: number;

  @ApiProperty({ type: 'integer' })
  notificationCount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class AdminUserDetailDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ enum: Object.values(Role), enumName: 'Role' })
  role!: Role;

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty()
  telegramLinked!: boolean;

  @ApiProperty({ type: String, nullable: true })
  quietHoursStart!: string | null;

  @ApiProperty({ type: String, nullable: true })
  quietHoursEnd!: string | null;

  @ApiProperty({ type: String, nullable: true })
  timezone!: string | null;

  @ApiProperty({ type: [TriggerResponseDto] })
  triggers!: TriggerResponseDto[];

  @ApiProperty({ type: 'integer' })
  notificationCount!: number;

  @ApiProperty({ type: 'integer' })
  pinnedCityCount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}
