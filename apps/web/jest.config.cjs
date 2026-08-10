const preset = require('../../jest.preset.cjs');

module.exports = {
  ...preset,
  testEnvironment: 'jsdom',
  // jest-environment-jsdom defaults to the 'browser' export condition, which
  // matches msw's `"browser": null` guard on its `./node` subpath export and
  // makes `import { setupServer } from 'msw/node'` fail to resolve. Clearing
  // the condition list restores plain Node resolution for that subpath.
  testEnvironmentOptions: { customExportConditions: [''] },
  // Must run before setupFilesAfterEnv: msw/node needs fetch/Request/Response
  // to already exist on globalThis by the time setup.ts imports it. Order
  // matters within this array too — see web-platform-polyfills.ts.
  setupFiles: [
    '<rootDir>/src/test/web-platform-polyfills.ts',
    '<rootDir>/src/test/fetch-polyfill.ts',
  ],
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  moduleNameMapper: {
    ...preset.moduleNameMapper,
    '\\.css$': '<rootDir>/src/test/style-stub.cjs',
  },
  // The root preset only transforms @modelcontextprotocol inside node_modules
  // (api-side concern), and only recognises .ts/.tsx/.js/.jsx. msw@2.15's
  // dependency graph (e.g. `rettime`) ships ESM-only, as a bare .mjs with no
  // commonjs build, so both the pattern and the ignore-list need widening —
  // transform every extension the preset already knows plus .mjs/.cjs, and
  // don't skip any node_modules package rather than chase each one by name.
  transform: {
    '^.+\\.([mc]?[tj])sx?$': preset.transform['^.+\\.(t|j)sx?$'],
  },
  transformIgnorePatterns: [],
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
};
