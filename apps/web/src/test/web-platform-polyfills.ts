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
import { BroadcastChannel, MessageChannel as NodeMessageChannel, MessagePort } from 'node:worker_threads';

/**
 * `node:worker_threads`' `MessagePort` wraps a real libuv handle that keeps
 * the process alive until closed — unlike jsdom's own (absent) implementation.
 * React's `scheduler` package detects a global `MessageChannel` and uses it
 * to schedule work, but never closes the ports it creates (it expects the
 * page/tab to end the process, not a Jest worker to exit cleanly). Left
 * referenced, any test that renders a React tree (e.g. via
 * `@testing-library/react`) leaves an open MESSAGEPORT handle and Jest hangs
 * past its default one-second exit check.
 *
 * A plain `port.unref()` right after construction is not enough: attaching a
 * `'message'` listener implicitly calls the port's internal `start()`, which
 * re-`ref()`s the handle — exactly what `scheduler` does. So `ref()` itself
 * is neutered here, which keeps the channel fully functional for undici and
 * the scheduler alike (messages still flow) — it just permanently stops
 * counting against Node's "should the event loop stay alive" decision.
 */
class MessageChannel extends NodeMessageChannel {
  constructor() {
    super();
    for (const port of [this.port1, this.port2]) {
      port.ref = () => port;
      port.unref();
    }
  }
}

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
