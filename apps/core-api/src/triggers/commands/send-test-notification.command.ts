import { HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Command, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { randomUUID } from 'node:crypto';
import { RedisService } from '@app/common';
import {
  EVENT_PUBLISHER,
  routingKeyFor,
  TriggerFiredEvent,
} from '@app/contracts';
import type { EventPublisher } from '@app/contracts';
import { TriggerTestResultDto } from '../dto/trigger-response.dto';
import { TriggersRepository } from '../triggers.repository';

export const TEST_COOLDOWN_SEC = 600; // 10 minutes

export class SendTestNotificationCommand extends Command<TriggerTestResultDto> {
  constructor(
    readonly userId: string,
    readonly id: string,
  ) {
    super();
  }
}

/**
 * Publish a test event for the trigger through its configured channels. Runs
 * the normal notifier path (retry/DLQ + history) but flagged as a test.
 */
@CommandHandler(SendTestNotificationCommand)
export class SendTestNotificationHandler implements ICommandHandler<
  SendTestNotificationCommand,
  TriggerTestResultDto
> {
  constructor(
    private readonly triggers: TriggersRepository,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    private readonly redis: RedisService,
  ) {}

  async execute({
    userId,
    id,
  }: SendTestNotificationCommand): Promise<TriggerTestResultDto> {
    const trigger = await this.triggers.findOwned(userId, id);
    const retryAfter = await this.redis.consumeCooldown(
      `trigger-test:${userId}`,
      TEST_COOLDOWN_SEC,
    );
    if (retryAfter > 0) {
      throw new HttpException(
        {
          message: `Please wait ${retryAfter}s before sending another test`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const event: TriggerFiredEvent = {
      eventId: randomUUID(),
      triggerId: trigger.id,
      userId: trigger.userId,
      triggerName: trigger.name,
      city: trigger.city,
      conditions: trigger.conditions.map((c) => ({
        metric: c.metric,
        operator: c.operator,
        threshold: c.threshold,
        observedValue: c.lastObservedValue ?? c.threshold,
      })),
      conditionLogic: trigger.conditionLogic,
      channels: trigger.channels,
      firedAt: new Date().toISOString(),
      test: true,
    };
    for (const channel of trigger.channels) {
      await this.publisher.publish(routingKeyFor(channel), event);
    }
    return { sent: trigger.channels };
  }
}
