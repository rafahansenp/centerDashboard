import { loadConfig } from '../config.js';

const validEnv = {
  DATABASE_URL: 'postgresql://center:center@localhost:5432/center',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  PII_PEPPER: 'y'.repeat(32),
  CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
  ANTHROPIC_API_KEY: 'sk-ant-test',
  UAPPI_BASE_URL: 'https://api.uappi.com.br',
  WHATSAPP_APP_SECRET: 'secret',
  WHATSAPP_VERIFY_TOKEN: 'verify',
  WHATSAPP_ACCESS_TOKEN: 'access',
  WHATSAPP_PHONE_NUMBER_ID: '123',
};

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3333);
    expect(config.uappiBaseUrl).toBe('https://api.uappi.com.br');
  });

  it('honours an explicit PORT', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080' }).port).toBe(8080);
  });

  it('throws naming the missing variable', () => {
    const { JWT_SECRET: _omitted, ...incomplete } = validEnv;
    expect(() => loadConfig(incomplete)).toThrow(/JWT_SECRET/);
  });

  it('rejects a PII pepper shorter than 32 characters', () => {
    expect(() => loadConfig({ ...validEnv, PII_PEPPER: 'curto' })).toThrow(/PII_PEPPER/);
  });

  it('rejects a credentials encryption key that is not 64 hex characters', () => {
    expect(() => loadConfig({ ...validEnv, CREDENTIALS_ENCRYPTION_KEY: 'curto' }))
      .toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...validEnv, CREDENTIALS_ENCRYPTION_KEY: 'z'.repeat(64) }))
      .toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });

  it('defaults the sync interval to 30 minutes', () => {
    expect(loadConfig(validEnv).syncIntervalMinutes).toBe(30);
  });

  it('refuses a sync interval below 10 minutes', () => {
    expect(() => loadConfig({ ...validEnv, SYNC_INTERVAL_MINUTES: '2' }))
      .toThrow(/SYNC_INTERVAL_MINUTES/);
  });

  it('defaults mockExternalApis to false', () => {
    expect(loadConfig(validEnv).mockExternalApis).toBe(false);
  });

  it('parses the literal string "true" as true, and everything else as false', () => {
    expect(loadConfig({ ...validEnv, MOCK_EXTERNAL_APIS: 'true' }).mockExternalApis).toBe(true);
    expect(loadConfig({ ...validEnv, MOCK_EXTERNAL_APIS: 'false' }).mockExternalApis).toBe(false);
    expect(loadConfig({ ...validEnv, MOCK_EXTERNAL_APIS: 'yes' }).mockExternalApis).toBe(false);
  });
});
