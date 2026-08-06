import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import { testConfig } from './helpers/config.js';

const validUser = {
  id: 'user_1', email: 'ana@example.com', name: 'Ana',
  role: 'ADMIN' as const, organizationId: 'org_1', passwordHash: '',
};

async function buildTestServer(userRow: unknown) {
  const prisma = {
    user: { findUnique: jest.fn(async () => userRow) },
    organization: {
      findUnique: jest.fn(async () => ({
        id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: null,
        uappiApiKey: null, uappiSecretKey: null,
      })),
    },
  } as unknown as PrismaClient;

  return buildServer({
    config: testConfig,
    prisma,
    gateway: { listMetrics: jest.fn(async () => []) } as unknown as MetricGateway,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox: new SecretBox(testConfig.credentialsEncryptionKey),
    queue: { enqueue: jest.fn(async () => {}) },
  });
}

describe('GET /health', () => {
  it('answers without authentication', async () => {
    const app = await buildTestServer(null);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('POST /auth/login', () => {
  it('returns a token for valid credentials', async () => {
    const app = await buildTestServer({ ...validUser, passwordHash: await hashPassword('segredo123') });
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ana@example.com', password: 'segredo123' },
    });
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().token).toBe('string');
    await app.close();
  });

  it('rejects a wrong password with 401', async () => {
    const app = await buildTestServer({ ...validUser, passwordHash: await hashPassword('segredo123') });
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ana@example.com', password: 'errada' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().message).toBe('credenciais inválidas');
    await app.close();
  });

  it('gives the same 401 for an unknown email (no user enumeration)', async () => {
    const app = await buildTestServer(null);
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ninguem@example.com', password: 'qualquer' },
    });
    expect(response.json().message).toBe('credenciais inválidas');
    await app.close();
  });

  it('rejects a malformed body with 400', async () => {
    const app = await buildTestServer(null);
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'x' } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('blocks the eleventh login attempt from the same address with 429', async () => {
    const app = await buildTestServer(null);
    const attempt = () => app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.7' },
      payload: { email: 'ana@example.com', password: 'errada' },
    });
    for (let i = 0; i < 10; i += 1) expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);
    await app.close();
  });
});

describe('GET /auth/me', () => {
  it('returns 401 without a token', async () => {
    const app = await buildTestServer(validUser);
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 for a token signed with another secret', async () => {
    const app = await buildTestServer(validUser);
    const response = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.invalid' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns the authenticated identity for a valid token', async () => {
    const app = await buildTestServer({ ...validUser, passwordHash: await hashPassword('segredo123') });
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ana@example.com', password: 'segredo123' },
    });
    const response = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${login.json().token}` },
    });
    expect(response.json()).toEqual({ userId: 'user_1', organizationId: 'org_1', role: 'ADMIN' });
    await app.close();
  });
});
