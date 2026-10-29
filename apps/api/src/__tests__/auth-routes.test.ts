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
  active: true, mustChangePassword: false,
};

let lastPrisma: PrismaClient;

async function buildTestServer(userRow: unknown, orgStatus: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  const prisma = {
    user: { findUnique: jest.fn(async () => userRow), update: jest.fn(async () => userRow) },
    organization: {
      findUnique: jest.fn(async () => ({ id: 'org_1', status: orgStatus })),
    },
  } as unknown as PrismaClient;
  lastPrisma = prisma;

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
    const unknownApp = await buildTestServer(null);
    const unknownResponse = await unknownApp.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ninguem@example.com', password: 'qualquer' },
    });
    await unknownApp.close();

    const knownApp = await buildTestServer({ ...validUser, passwordHash: await hashPassword('segredo123') });
    const wrongPasswordResponse = await knownApp.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ana@example.com', password: 'errada' },
    });
    await knownApp.close();

    expect(unknownResponse.statusCode).toBe(401);
    expect(wrongPasswordResponse.statusCode).toBe(401);
    // Corpo byte-a-byte idêntico: nada (nem tamanho, nem campo extra)
    // distingue "email não existe" de "senha errada".
    expect(unknownResponse.body).toBe(wrongPasswordResponse.body);
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

  it('keys the rate limit by client address, not globally (requires trustProxy)', async () => {
    const app = await buildTestServer(null);
    const attemptFrom = (xForwardedFor: string) => app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'x-forwarded-for': xForwardedFor },
      payload: { email: 'ana@example.com', password: 'errada' },
    });

    // Address A exhausts its bucket.
    for (let i = 0; i < 10; i += 1) expect((await attemptFrom('198.51.100.1')).statusCode).toBe(401);
    expect((await attemptFrom('198.51.100.1')).statusCode).toBe(429);

    // Address B is unaffected: still gets a normal 401, not 429.
    expect((await attemptFrom('198.51.100.2')).statusCode).toBe(401);
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

describe('login state checks', () => {
  it('deactivated user login gets the same body as a wrong password', async () => {
    const passwordHash = await hashPassword('segredo123');
    const inactiveApp = await buildTestServer({ ...validUser, passwordHash, active: false });
    const inactive = await inactiveApp.inject({
      method: 'POST', url: '/auth/login', payload: { email: 'ana@example.com', password: 'segredo123' },
    });
    await inactiveApp.close();
    const wrongApp = await buildTestServer({ ...validUser, passwordHash });
    const wrong = await wrongApp.inject({
      method: 'POST', url: '/auth/login', payload: { email: 'ana@example.com', password: 'errada' },
    });
    await wrongApp.close();
    expect(inactive.statusCode).toBe(401);
    expect(inactive.json()).toEqual(wrong.json());
  });

  it('suspended organization login returns 403 organization_suspended', async () => {
    const app = await buildTestServer({ ...validUser, passwordHash: await hashPassword('segredo123') }, 'SUSPENDED');
    const res = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: 'ana@example.com', password: 'segredo123' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('organization_suspended');
    await app.close();
  });
});

describe('POST /auth/password', () => {
  async function loggedIn(mustChangePassword = false) {
    const app = await buildTestServer({
      ...validUser, passwordHash: await hashPassword('segredo123'), mustChangePassword,
    });
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: 'ana@example.com', password: 'segredo123' },
    });
    return { app, headers: { authorization: `Bearer ${login.json().token}` } };
  }

  it('rejects a wrong current password (401) and a short new one (400)', async () => {
    const { app, headers } = await loggedIn();
    const wrong = await app.inject({
      method: 'POST', url: '/auth/password', headers,
      payload: { currentPassword: 'errada', newPassword: 'uma-senha-bem-longa' },
    });
    expect(wrong.statusCode).toBe(401);
    const short = await app.inject({
      method: 'POST', url: '/auth/password', headers,
      payload: { currentPassword: 'segredo123', newPassword: 'curta' },
    });
    expect(short.statusCode).toBe(400);
    await app.close();
  });

  it('clears mustChangePassword', async () => {
    const { app, headers } = await loggedIn(true);
    const res = await app.inject({
      method: 'POST', url: '/auth/password', headers,
      payload: { currentPassword: 'segredo123', newPassword: 'uma-senha-bem-longa' },
    });
    expect(res.statusCode).toBe(204);
    const update = lastPrisma.user.update as jest.Mock;
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: 'user_1' });
    expect(arg.data.mustChangePassword).toBe(false);
    expect(arg.data.passwordHash).toMatch(/^scrypt\$/);
    await app.close();
  });
});
