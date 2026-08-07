const preset = require('../../jest.preset.cjs');

module.exports = {
  ...preset,
  collectCoverageFrom: ['src/agent/**/*.ts'],
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
  moduleNameMapper: {
    ...preset.moduleNameMapper,
    // See src/test/ai-sdk-provider-utils-test-stub.cjs: `ai/test` (needed for
    // MockLanguageModelV2 in agent.test.ts) transitively requires msw/vitest
    // through an unrelated helper this repo never exercises.
    '^@ai-sdk/provider-utils/test$': '<rootDir>/src/test/ai-sdk-provider-utils-test-stub.cjs',
  },
};
