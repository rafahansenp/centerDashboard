import type { AppConfig } from '../../config.js';

export const testConfig = {
  port: 0, databaseUrl: 'postgresql://x', redisUrl: 'redis://x',
  jwtSecret: 'x'.repeat(32), piiPepper: 'y'.repeat(32),
  credentialsEncryptionKey: 'a'.repeat(64),
  anthropicApiKey: 'sk-ant-test',
  uappiBaseUrl: 'https://api.uappi.com.br', ga4CredentialsJson: '',
  syncIntervalMinutes: 30, syncBackfillDays: 90, mockExternalApis: false,
  whatsapp: { appSecret: 's', verifyToken: 'v', accessToken: 'a', phoneNumberId: '1' },
} satisfies AppConfig;
