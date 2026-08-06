module.exports = {
  ...require('../../jest.preset.cjs'),
  collectCoverageFrom: ['src/agent/**/*.ts'],
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
};
