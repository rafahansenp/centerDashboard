import type { PrismaClient } from '@prisma/client';
import { SecretBox } from '@center/secrets';
import { decryptSecrets, encryptSecrets, loadIntegrationStates } from '../integrations/repository.js';
import { testConfig } from './helpers/config.js';

function fakePrisma(rows: unknown[]): PrismaClient {
  return { integration: { findMany: jest.fn(async () => rows) } } as unknown as PrismaClient;
}

describe('loadIntegrationStates', () => {
  it('hasBigQueryDataset reflects config', async () => {
    const prisma = fakePrisma([
      { kind: 'WEB_ANALYTICS', status: 'OK', config: { propertyId: '1', bigQueryDataset: 'ds' } },
      { kind: 'APP_ANALYTICS', status: 'PENDING', config: { propertyId: '2' } },
    ]);
    expect(await loadIntegrationStates(prisma, 'org_1')).toEqual([
      { kind: 'WEB_ANALYTICS', status: 'OK', hasBigQueryDataset: true },
      { kind: 'APP_ANALYTICS', status: 'PENDING', hasBigQueryDataset: false },
    ]);
  });
});

describe('encryptSecrets / decryptSecrets', () => {
  const box = new SecretBox(testConfig.credentialsEncryptionKey);

  it('encrypt/decrypt round-trips', () => {
    const cipher = encryptSecrets(box, { keyJson: '{"a":1}' });
    expect(cipher).not.toContain('keyJson');
    expect(decryptSecrets(box, cipher)).toEqual({ keyJson: '{"a":1}' });
  });

  it('returns null when there are no secrets', () => {
    expect(decryptSecrets(box, null)).toBeNull();
  });
});
