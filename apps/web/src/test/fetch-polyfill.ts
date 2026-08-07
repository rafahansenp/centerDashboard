/**
 * jsdom, as bundled by `jest-environment-jsdom@29`, predates the Fetch API —
 * it has no global `fetch`/`Request`/`Response`/`Headers`. MSW 2's Node
 * interceptors reference these at import time, so without this polyfill
 * `import { setupServer } from 'msw/node'` throws `ReferenceError: Request is
 * not defined` before a single test runs (see msw's own FAQ on this exact
 * error under Jest + jsdom).
 *
 * This file MUST be loaded via Jest's `setupFiles` (which runs before the
 * test framework is installed), not `setupFilesAfterEnv` — by the time
 * `setupFilesAfterEnv`/`setup.ts` runs and imports `msw/node`, these globals
 * already need to exist. It must also run after ./web-platform-polyfills.ts,
 * since `undici` itself needs TextDecoder/ReadableStream/etc. at import time.
 */
import { fetch, FormData, Headers, Request, Response } from 'undici';

Object.defineProperties(globalThis, {
  fetch: { value: fetch, writable: true, configurable: true },
  Headers: { value: Headers, writable: true, configurable: true },
  Request: { value: Request, writable: true, configurable: true },
  Response: { value: Response, writable: true, configurable: true },
  FormData: { value: FormData, writable: true, configurable: true },
});
