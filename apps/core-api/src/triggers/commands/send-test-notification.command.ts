import {
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { API_LIMITS } from '../../meta/limits';

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
 *
 * Publishes straight to the broker rather than through the outbox the watcher
 * uses, and the difference is deliberate: an outbox guarantees a delivery the
 * system owes whether or not anyone is waiting for it, which is exactly what a
 * fired trigger is. A test send is owed to nobody — the user asked for it, is
 * watching the response, and can simply ask again. Staging it would mean
 * core-api running a relay of its own for a message whose only value is being
 * immediate.
 */
@CommandHandler(SendTestNotificationCommand)
export class SendTestNotificationHandler implements ICommandHandler<
  SendTestNotificationCommand,
  TriggerTestResultDto
> {
  private readonly logger = new Logger(SendTestNotificationHandler.name);

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
    const cooldownKey = `trigger-test:${userId}`;
    const retryAfter = await this.redis.consumeCooldown(
      cooldownKey,
      API_LIMITS.testCooldownSec,
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
    try {
      for (const channel of trigger.channels) {
        await this.publisher.publish(routingKeyFor(channel), event);
      }
    } catch (err) {
      // Nothing is owed and nothing was staged, so the honest answer is "not
      // now" — and the cooldown goes back, since charging a ten-minute wait for
      // an attempt that failed on our side would extend the outage for this
      // user well past the outage itself.
      await this.redis.clearCooldown(cooldownKey).catch(() => undefined);
      this.logger.error(
        `Test notification for trigger ${trigger.id} could not be published: ${String(err)}`,
      );
      throw new ServiceUnavailableException(
        'Notifications are temporarily unavailable — please try again shortly',
      );
    }
    return { sent: trigger.channels };
  }
}
