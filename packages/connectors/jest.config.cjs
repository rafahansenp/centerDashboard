module.exports = {
  ...require('../../jest.preset.cjs'),
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
};
