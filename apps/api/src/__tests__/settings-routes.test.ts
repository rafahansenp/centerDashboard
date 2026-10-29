import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import { testConfig } from './helpers/config.js';

const secretBox = new SecretBox(testConfig.credentialsEncryptionKey);

async function setup(role: 'ADMIN' | 'MEMBER', integrations: unknown[] = [], syncState: unknown = null) {
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'user_1', email: 'ana@example.com', name: 'Ana', role,
        organizationId: 'org_1', passwordHash: await hashPassword('segredo123'),
        active: true, mustChangePassword: false,
      })),
    },
    organization: { findUnique: jest.fn(async () => ({ id: 'org_1', status: 'ACTIVE' })) },
    integration: { findMany: jest.fn(async () => integrations) },
    syncState: { findUnique: jest.fn(async () => syncState) },
  } as unknown as PrismaClient;

  const app = await buildServer({
    config: testConfig, prisma,
    gateway: {} as unknown as MetricGateway,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox,
    queue: { enqueue: jest.fn(async () => {}) },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'ana@example.com', password: 'segredo123' },
  });
  return { app, prisma, token: login.json().token as string };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /api/settings/integrations', () => {
  it('requires a token', async () => {
    const { app } = await setup('ADMIN');
    expect((await app.inject({ method: 'GET', url: '/api/settings/integrations' })).statusCode).toBe(401);
    await app.close();
  });

  it('MEMBER gets 403', async () => {
    const { app, token } = await setup('MEMBER');
    expect((await app.inject({ method: 'GET', url: '/api/settings/integrations', headers: auth(token) })).statusCode).toBe(403);
    await app.close();
  });

  it('returns kind, provider, status and lastSyncedAt only', async () => {
    const lastSyncedAt = new Date('2026-03-15T10:00:00.000Z');
    const { app, token } = await setup('ADMIN', [
      { kind: 'COMMERCE', provider: 'UAPPI', status: 'OK', config: {}, secrets: 'v1.x.y.z', lastError: 'boom' },
      { kind: 'WEB_ANALYTICS', provider: 'GA4', status: 'PENDING', config: { propertyId: '1' }, secrets: null },
    ], { lastSyncedAt });
    const response = await app.inject({ method: 'GET', url: '/api/settings/integrations', headers: auth(token) });
    const { integrations } = response.json();
    for (const item of integrations) {
      expect(Object.keys(item)).toEqual(['kind', 'provider', 'status', 'lastSyncedAt']);
    }
    expect(integrations[0].lastSyncedAt).toBe(lastSyncedAt.toISOString());
    expect(integrations[1].lastSyncedAt).toBeNull();
    expect(JSON.stringify(integrations)).not.toMatch(/v1\.|boom|propertyId/);
    await app.close();
  });

  it('PUT is gone (404)', async () => {
    const { app, token } = await setup('ADMIN');
    const response = await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token), payload: { ga4PropertyId: '1' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
