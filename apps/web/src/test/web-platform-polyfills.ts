/**
 * `undici` (imported by ./polyfills.ts to backfill fetch/Request/Response for
 * jsdom) reads several web-platform globals — TextDecoder/TextEncoder,
 * ReadableStream, MessageChannel, BroadcastChannel — at its own module load
 * time. This file has to run — and fully finish, including its own imports —
 * strictly before `./polyfills.ts` does, so it is listed first in Jest's
 * `setupFiles` array. (A single combined file would not work: within one ES
 * module, all of its static imports are evaluated before any of the module's
 * own top-level statements run, so an `Object.defineProperties` call placed
 * between two `import`s would still run after both had already executed.)
 */
import { TextDecoder, TextEncoder } from 'node:util';
import { ReadableStream, TransformStream, WritableStream } from 'node:stream/web';
import { BroadcastChannel, MessageChannel, MessagePort } from 'node:worker_threads';

Object.defineProperties(globalThis, {
  TextDecoder: { value: TextDecoder, writable: true, configurable: true },
  TextEncoder: { value: TextEncoder, writable: true, configurable: true },
  ReadableStream: { value: ReadableStream, writable: true, configurable: true },
  TransformStream: { value: TransformStream, writable: true, configurable: true },
  WritableStream: { value: WritableStream, writable: true, configurable: true },
  MessageChannel: { value: MessageChannel, writable: true, configurable: true },
  MessagePort: { value: MessagePort, writable: true, configurable: true },
  BroadcastChannel: { value: BroadcastChannel, writable: true, configurable: true },
});
