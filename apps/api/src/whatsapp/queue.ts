import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { InboundMessage } from './parse.js';

export const WHATSAPP_QUEUE_NAME = 'whatsapp-inbound';

export interface MessageQueue {
  enqueue(message: InboundMessage): Promise<void>;
}

export class BullMessageQueue implements MessageQueue {
  private readonly queue: Queue<InboundMessage>;

  constructor(redis: Redis) {
    this.queue = new Queue<InboundMessage>(WHATSAPP_QUEUE_NAME, { connection: redis });
  }

  async enqueue(message: InboundMessage): Promise<void> {
    await this.queue.add('inbound', message, {
      // jobId = wamid: segunda camada de idempotência, agora na fila.
      jobId: message.wamid,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
