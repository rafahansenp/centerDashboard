module.exports = {
  ...require('../../jest.preset.cjs'),
  maxWorkers: 1,
  testTimeout: 20_000,
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
};
