// `ai/test` re-exports a handful of stream/id helpers from
// `@ai-sdk/provider-utils/test` purely as a convenience — `MockLanguageModelV2`
// (what `agent.test.ts` actually imports `ai/test` for) is implemented directly
// inside `ai`'s own dist/test bundle and does not depend on this module at all.
//
// The real `@ai-sdk/provider-utils/test` barrel, however, also bundles an
// unrelated `test-server.ts` helper that top-level `require()`s `msw`,
// `msw/node` and `vitest`. `msw`'s dependency graph pulls in `rettime`, which
// ships ESM-only (no CommonJS build) — and this repo has no `vitest`
// dependency at all (Jest via @swc/jest is the toolchain here, see
// jest.preset.cjs). Loading the real module under Jest fails before any test
// code runs, even though nothing we test exercises that code path.
//
// This stub re-implements the same exported surface with trivial/throwing
// bodies. It's only ever loaded as a side-effect of importing `ai/test`; none
// of these functions are called by `MockLanguageModelV2`-based tests, so the
// stub bodies never need to do anything real. If a future test needs a real
// implementation, drop this stub and fix the msw/vitest resolution properly
// instead (see apps/web/jest.config.cjs for that heavier precedent).
class TestResponseController {
  constructor() {
    throw new Error('TestResponseController is stubbed out under Jest — see ai-sdk-provider-utils-test-stub.cjs');
  }
}

function notImplemented() {
  throw new Error('This ai/test helper is stubbed out under Jest — see ai-sdk-provider-utils-test-stub.cjs');
}

function mockId({ prefix = 'id' } = {}) {
  let counter = 0;
  return () => `${prefix}-${counter++}`;
}

module.exports = {
  TestResponseController,
  convertArrayToAsyncIterable: notImplemented,
  convertArrayToReadableStream: notImplemented,
  convertAsyncIterableToArray: notImplemented,
  convertReadableStreamToArray: notImplemented,
  convertResponseStreamToArray: notImplemented,
  createTestServer: notImplemented,
  isNodeVersion: () => false,
  mockId,
};
