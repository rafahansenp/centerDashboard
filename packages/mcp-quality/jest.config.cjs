module.exports = {
  ...require('../../jest.preset.cjs'),
  maxWorkers: 1,
  testTimeout: 20_000,
  setupFiles: ['<rootDir>/jest.setup.cjs'],
};
