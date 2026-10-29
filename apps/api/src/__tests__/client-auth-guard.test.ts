import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import { testConfig } from './helpers/config.js';

async function setup(beforeReady?: (app: Awaited<ReturnType<typeof buildServer>>) => void) {
  // Linhas mutáveis: os testes alteram o "banco" entre requisições.
  const userRow = {
    id: 'user_1', email: 'ana@example.com', name: 'Ana', role: 'ADMIN' as 'ADMIN' | 'MEMBER',
    organizationId: 'org_1', passwordHash: await hashPassword('segredo123'),
    active: true, mustChangePassword: false,
  };
  const orgRow = { id: 'org_1', status: 'ACTIVE' as 'ACTIVE' | 'SUSPENDED' };
  const prisma = {
    user: { findUnique: jest.fn(async () => userRow) },
    organization: { findUnique: jest.fn(async () => orgRow) },
    integration: { findMany: jest.fn(async () => []) },
    syncState: { findUnique: jest.fn(async () => null) },
  } as unknown as PrismaClient;

  const app = await buildServer({
    config: testConfig, prisma,
    gateway: { listMetrics: jest.fn(async () => []) } as unknown as MetricGateway,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox: new SecretBox(testConfig.credentialsEncryptionKey),
    queue: { enqueue: jest.fn(async () => {}) },
  });
  beforeReady?.(app);
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { email: 'ana@example.com', password: 'segredo123' },
  });
  return { app, userRow, orgRow, token: login.json().token as string };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('client auth guard', () => {
  it('rejects a token signed with aud=operator', async () => {
    const { app } = await setup();
    const token = app.jwt.sign(
      { userId: 'user_1', organizationId: 'org_1', role: 'ADMIN' }, { aud: 'operator' } as never,
    );
    const res = await app.inject({ method: 'GET', url: '/api/metrics/catalog', headers: bearer(token) });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('deactivated user with a still-valid token gets 401', async () => {
    const { app, userRow, token } = await setup();
    userRow.active = false;
    const res = await app.inject({ method: 'GET', url: '/api/metrics/catalog', headers: bearer(token) });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('token issued before suspension gets 403 organization_suspended', async () => {
    const { app, orgRow, token } = await setup();
    orgRow.status = 'SUSPENDED';
    const res = await app.inject({ method: 'GET', url: '/api/metrics/catalog', headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('organization_suspended');
    await app.close();
  });

  it('role comes from the database', async () => {
    const { app, userRow, token } = await setup();
    userRow.role = 'MEMBER';
    const res = await app.inject({ method: 'GET', url: '/api/settings/integrations', headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('mustChangePassword blocks data routes but not /auth/me', async () => {
    const { app, userRow, token } = await setup();
    userRow.mustChangePassword = true;
    const data = await app.inject({ method: 'GET', url: '/api/metrics/catalog', headers: bearer(token) });
    expect(data.statusCode).toBe(403);
    expect(data.json().error).toBe('password_change_required');
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    await app.close();
  });

  it('view session token gets 403 readonly_session on a route without readonlySafe', async () => {
    const { app } = await setup();
    const token = app.jwt.sign({
      userId: 'operator:op_1', organizationId: 'org_1', role: 'ADMIN', viewedBy: 'op_1',
    });
    const res = await app.inject({ method: 'GET', url: '/api/metrics/catalog', headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('readonly_session');
    await app.close();
  });

  it('rejects a token signed without aud', async () => {
    const { app } = await setup();
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: 'user_1', organizationId: 'org_1', role: 'ADMIN' })}`;
    const signature = createHmac('sha256', testConfig.jwtSecret).update(unsigned).digest('base64url');
    const res = await app.inject({
      method: 'GET', url: '/api/metrics/catalog', headers: bearer(`${unsigned}.${signature}`),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('view session token passes on a readonlySafe route (/auth/me) -> 200', async () => {
    const { app } = await setup();
    const token = app.jwt.sign({
      userId: 'operator:op_1', organizationId: 'org_1', role: 'ADMIN', viewedBy: 'op_1',
    });
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('logs view session requests even when denied', async () => {
    const info: jest.SpyInstance[] = [];
    const { app } = await setup((instance) => {
      instance.addHook('onRequest', async (request) => { info.push(jest.spyOn(request.log, 'info')); });
    });
    info.length = 0; // descarta a requisição de login
    const token = app.jwt.sign({
      userId: 'operator:op_1', organizationId: 'org_1', role: 'ADMIN', viewedBy: 'op_1',
    });
    const res = await app.inject({ method: 'GET', url: '/api/metrics/catalog', headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(info[0]).toBeDefined();
    expect(info[0]).toHaveBeenCalledWith(
      expect.objectContaining({ viewedBy: 'op_1', organizationId: 'org_1' }), 'view_session_request',
    );
    await app.close();
  });
});
