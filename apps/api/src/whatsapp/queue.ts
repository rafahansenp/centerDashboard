import type { InboundMessage } from './parse.js';

export interface MessageQueue {
  enqueue(message: InboundMessage): Promise<void>;
}
