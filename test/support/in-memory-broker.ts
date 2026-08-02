import { ConsumeMessage } from 'amqplib';
import { Channel } from '@app/contracts';
import { RabbitConsumerService } from '../../apps/notifier/src/messaging/rabbit-consumer.service';

export interface ParkedMessage {
  routingKey: string;
  headers: Record<string, unknown>;
  body: unknown;
}

type Published = {
  routingKey: string;
  content: Buffer;
  options: { headers?: Record<string, unknown>; messageId?: string };
};

/**
 * Drives the real consumer against an in-memory exchange: whatever the consumer
 * republishes onto a `.retry.N` key is fed straight back to it (skipping the
 * queue TTL, which is Rabbit's job, not ours), and `.dead` keys are parked.
 * That makes the whole ladder observable without a broker.
 */
export class InMemoryBroker {
  readonly parked: ParkedMessage[] = [];
  readonly deliveries: ConsumeMessage[] = [];
  private readonly pending: Published[] = [];
  private acked = 0;

  readonly channelWrapper = {
    ack: () => {
      this.acked++;
    },
    publish: (
      _exchange: string,
      routingKey: string,
      content: Buffer,
      options: Published['options'],
    ): Promise<void> => {
      this.pending.push({ routingKey, content, options });
      return Promise.resolve();
    },
  };

  attachTo(consumer: RabbitConsumerService): void {
    (
      consumer as unknown as { channelWrapper: typeof this.channelWrapper }
    ).channelWrapper = this.channelWrapper;
  }

  get ackCount(): number {
    return this.acked;
  }

  /**
   * Deliver a message and keep re-delivering whatever comes back on a retry
   * key, until the ladder ends in the dead queue or runs out of bounces.
   */
  async run(
    consumer: RabbitConsumerService,
    channel: Channel,
    first: ConsumeMessage,
    maxBounces = 10,
  ): Promise<void> {
    let next: ConsumeMessage | null = first;
    for (let i = 0; next && i < maxBounces; i++) {
      this.deliveries.push(next);
      await handle(consumer, channel, next);
      next = this.drain();
    }
  }

  /** Consume what the last delivery republished; null when nothing bounced. */
  private drain(): ConsumeMessage | null {
    const published = this.pending.splice(0, this.pending.length);
    let redelivery: ConsumeMessage | null = null;
    for (const msg of published) {
      const headers = msg.options.headers ?? {};
      if (msg.routingKey.endsWith('.dead')) {
        this.parked.push({
          routingKey: msg.routingKey,
          headers,
          body: safeParse(msg.content),
        });
        continue;
      }
      redelivery = {
        content: msg.content,
        properties: { messageId: msg.options.messageId, headers },
        fields: {},
      } as unknown as ConsumeMessage;
    }
    return redelivery;
  }
}

function handle(
  consumer: RabbitConsumerService,
  channel: Channel,
  msg: ConsumeMessage,
): Promise<void> {
  return (
    consumer as unknown as {
      handle: (c: Channel, m: ConsumeMessage) => Promise<void>;
    }
  ).handle(channel, msg);
}

function safeParse(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString());
  } catch {
    return content.toString();
  }
}
