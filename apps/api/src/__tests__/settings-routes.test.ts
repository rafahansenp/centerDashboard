import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import { testConfig } from './helpers/config.js';

const secretBox = new SecretBox(testConfig.credentialsEncryptionKey);

function buildOrgRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'org_1', ga4PropertyId: null, ga4BigQueryDataset: null,
    uappiApiKey: null, uappiSecretKey: null,
    ...overrides,
  };
}

async function setup(role: 'ADMIN' | 'MEMBER', orgRow: Record<string, unknown>) {
  const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...orgRow, ...data }));
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'user_1', email: 'ana@example.com', name: 'Ana', role,
        organizationId: 'org_1', passwordHash: await hashPassword('segredo123'),
      })),
    },
    organization: {
      findUnique: jest.fn(async () => orgRow),
      update,
    },
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
  return { app, prisma, update, token: login.json().token as string };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /api/settings/integrations', () => {
  it('requires a token', async () => {
    const { app } = await setup('ADMIN', buildOrgRow());
    expect((await app.inject({ method: 'GET', url: '/api/settings/integrations' })).statusCode).toBe(401);
    await app.close();
  });

  it('reports uappi as not configured and ga4 fields as null by default', async () => {
    const { app, token } = await setup('ADMIN', buildOrgRow());
    const response = await app.inject({ method: 'GET', url: '/api/settings/integrations', headers: auth(token) });
    expect(response.json()).toEqual({
      uappi: { configured: false }, ga4: { propertyId: null, bigQueryDataset: null },
    });
    await app.close();
  });

  it('reports uappi as configured without ever returning the ciphertext or the plaintext', async () => {
    const orgRow = buildOrgRow({
      uappiApiKey: secretBox.encrypt('ak-real'), uappiSecretKey: secretBox.encrypt('sk-real'),
      ga4PropertyId: '111', ga4BigQueryDataset: 'analytics_111',
    });
    const { app, token } = await setup('ADMIN', orgRow);
    const response = await app.inject({ method: 'GET', url: '/api/settings/integrations', headers: auth(token) });
    const body = response.json();
    expect(body).toEqual({
      uappi: { configured: true }, ga4: { propertyId: '111', bigQueryDataset: 'analytics_111' },
    });
    expect(JSON.stringify(body)).not.toMatch(/ak-real|sk-real|v1\./);
    await app.close();
  });

  it('is readable by a MEMBER — seeing what is configured is not sensitive', async () => {
    const { app, token } = await setup('MEMBER', buildOrgRow());
    expect((await app.inject({ method: 'GET', url: '/api/settings/integrations', headers: auth(token) })).statusCode).toBe(200);
    await app.close();
  });
});

describe('PUT /api/settings/integrations', () => {
  it('requires ADMIN — a MEMBER gets 403', async () => {
    const { app, token } = await setup('MEMBER', buildOrgRow());
    const response = await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token),
      payload: { ga4PropertyId: '111' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('encrypts the Uappi credentials before writing to the database', async () => {
    const { app, prisma, token } = await setup('ADMIN', buildOrgRow());
    await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token),
      payload: { uappiApiKey: 'ak-nova', uappiSecretKey: 'sk-nova' },
    });
    const call = (prisma.organization.update as jest.Mock).mock.calls[0]![0] as { data: Record<string, string> };
    expect(call.data.uappiApiKey).not.toBe('ak-nova');
    expect(call.data.uappiApiKey!.startsWith('v1.')).toBe(true);
    expect(secretBox.decrypt(call.data.uappiApiKey!)).toBe('ak-nova');
    expect(secretBox.decrypt(call.data.uappiSecretKey!)).toBe('sk-nova');
    await app.close();
  });

  it('writes ga4PropertyId and ga4BigQueryDataset in the clear — they are not secrets', async () => {
    const { app, prisma, token } = await setup('ADMIN', buildOrgRow());
    await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token),
      payload: { ga4PropertyId: '222', ga4BigQueryDataset: 'analytics_222' },
    });
    const call = (prisma.organization.update as jest.Mock).mock.calls[0]![0] as { data: Record<string, string> };
    expect(call.data).toMatchObject({ ga4PropertyId: '222', ga4BigQueryDataset: 'analytics_222' });
    await app.close();
  });

  it('leaves a field untouched when it is omitted from the body', async () => {
    const orgRow = buildOrgRow({ ga4PropertyId: '111' });
    const { app, prisma, token } = await setup('ADMIN', orgRow);
    await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token),
      payload: { ga4BigQueryDataset: 'analytics_111' },
    });
    const call = (prisma.organization.update as jest.Mock).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data).not.toHaveProperty('ga4PropertyId');
  });

  it('rejects an empty body with 400 instead of a no-op write', async () => {
    const { app, prisma, token } = await setup('ADMIN', buildOrgRow());
    const response = await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token), payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(prisma.organization.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the updated masked view, not the raw values', async () => {
    const { app, token } = await setup('ADMIN', buildOrgRow());
    const response = await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token),
      payload: { uappiApiKey: 'ak-nova', uappiSecretKey: 'sk-nova' },
    });
    expect(response.json()).toMatchObject({ uappi: { configured: true } });
  });
});
