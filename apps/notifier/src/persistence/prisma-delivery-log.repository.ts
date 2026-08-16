import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { Channel, NotifStatus, TriggerFiredEvent } from '@app/contracts';
import {
  ClaimResult,
  DeliveryLogRepository,
} from '../ports/delivery-log.repository';

const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class PrismaDeliveryLogRepository implements DeliveryLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async claim(
    channel: Channel,
    event: TriggerFiredEvent,
    leaseCutoff: Date,
  ): Promise<ClaimResult> {
    const now = new Date();
    try {
      await this.prisma.notification.create({
        data: {
          ...this.rowFor(channel, event, NotifStatus.PENDING),
          claimedAt: now,
        },
      });
      return 'claimed';
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }

    // Lost the race or this is a redelivery. One conditional UPDATE decides it,
    // so two consumers arriving together cannot both come away owning the send.
    const { count } = await this.prisma.notification.updateMany({
      where: {
        eventId: event.eventId,
        channel,
        status: { not: NotifStatus.SENT },
        OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
      },
      data: { status: NotifStatus.PENDING, claimedAt: now, error: null },
    });
    if (count > 0) {
      return 'claimed';
    }

    const existing = await this.prisma.notification.findUnique({
      where: { eventId_channel: { eventId: event.eventId, channel } },
      select: { status: true },
    });
    if (!existing) {
      // Vanished between the failed create and this read (a history wipe, say);
      // nothing holds it, and settle() writes the row once the send lands.
      return 'claimed';
    }
    return existing.status === NotifStatus.SENT ? 'duplicate' : 'in_flight';
  }

  async releaseClaim(channel: Channel, eventId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { eventId, channel, status: NotifStatus.PENDING },
      data: { claimedAt: null },
    });
  }

  async settle(
    channel: Channel,
    event: TriggerFiredEvent,
    status: NotifStatus,
    error?: string,
  ): Promise<void> {
    await this.prisma.notification.upsert({
      where: { eventId_channel: { eventId: event.eventId, channel } },
      create: this.rowFor(channel, event, status, error),
      update: { status, error: error ?? null },
    });
  }

  async deliveredDestinations(
    channel: Channel,
    eventId: string,
  ): Promise<string[]> {
    const row = await this.prisma.notification.findUnique({
      where: { eventId_channel: { eventId, channel } },
      select: { deliveredTo: true },
    });
    return row?.deliveredTo ?? [];
  }

  async markDelivered(
    channel: Channel,
    eventId: string,
    destination: string,
  ): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { eventId, channel },
      data: { deliveredTo: { push: destination } },
    });
  }

  private rowFor(
    channel: Channel,
    event: TriggerFiredEvent,
    status: NotifStatus,
    error?: string,
  ): Prisma.NotificationUncheckedCreateInput {
    return {
      eventId: event.eventId,
      triggerId: event.triggerId,
      userId: event.userId,
      channel,
      status,
      payload: event as unknown as Prisma.InputJsonValue,
      error: error ?? null,
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === UNIQUE_VIOLATION
  );
}
