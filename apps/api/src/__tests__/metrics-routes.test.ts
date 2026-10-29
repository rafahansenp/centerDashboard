import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import type { MetricSeries } from '@center/shared';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import { testConfig } from './helpers/config.js';

const series: MetricSeries = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency',
  granularity: 'day', total: 55000, points: [{ date: '2026-01-01', value: 55000 }],
};

async function setup(organizationId = 'org_1') {
  const gateway = {
    listMetrics: jest.fn(async () => [{
      id: 'commerce.revenue', label: 'Faturamento', description: 'd',
      source: 'commerce' as const, unit: 'currency' as const, dimensions: ['campaign'],
    }]),
    queryMetric: jest.fn(async () => series),
    queryBatch: jest.fn(async () => [series, series]),
    callTool: jest.fn(async () => ({ rows: [{ key: 'CAM-001', value: 16000 }] })),
  } as unknown as MetricGateway;

  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'user_1', email: 'ana@example.com', name: 'Ana', role: 'ADMIN' as const,
        organizationId, passwordHash: await hashPassword('segredo123'),
        active: true, mustChangePassword: false,
      })),
    },
    organization: {
      findUnique: jest.fn(async () => ({
        id: organizationId, status: 'ACTIVE',
      })),
    },
    integration: {
      findMany: jest.fn(async () => [
        { kind: 'WEB_ANALYTICS', status: 'OK', config: { propertyId: `prop_${organizationId}` } },
      ]),
    },
  } as unknown as PrismaClient;

  const app = await buildServer({
    config: testConfig, prisma, gateway,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox: new SecretBox(testConfig.credentialsEncryptionKey),
    queue: { enqueue: jest.fn(async () => {}) },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'ana@example.com', password: 'segredo123' },
  });
  return { app, gateway, token: login.json().token as string };
}

const validQuery = {
  metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-31', granularity: 'day',
};

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /api/metrics/catalog', () => {
  it('requires a token', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/metrics/catalog' })).statusCode).toBe(401);
    await app.close();
  });

  it('returns the merged catalog', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'GET', url: '/api/metrics/catalog', headers: auth(token),
    });
    expect(response.json().metrics).toHaveLength(1);
    await app.close();
  });
});

describe('POST /api/metrics/query', () => {
  it('requires a token', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/metrics/query', payload: validQuery })).statusCode).toBe(401);
    await app.close();
  });

  it('returns the series', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token), payload: validQuery,
    });
    expect(response.json().total).toBe(55000);
    await app.close();
  });

  it('injects the tenant from the token, never from the body', async () => {
    const { app, gateway, token } = await setup('org_1');
    await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token),
      // Cliente malicioso tentando forjar outro tenant:
      payload: { ...validQuery, tenant: { organizationId: 'org_ATACANTE', externalIds: { ga4PropertyId: 'roubado' } } },
    });
    expect(gateway.queryMetric).toHaveBeenCalledWith({
      ...validQuery,
      tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: 'prop_org_1' } },
    });
    await app.close();
  });

  it('rejects an invalid date format with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token),
      payload: { ...validQuery, from: '01/01/2026' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an inverted date range with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token),
      payload: { ...validQuery, from: '2026-02-01', to: '2026-01-01' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/anterior/);
    await app.close();
  });

  it('rejects a range longer than 400 days with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token),
      payload: { ...validQuery, from: '2024-01-01', to: '2026-01-01' },
    });
    expect(response.json().message).toMatch(/400 dias/);
    await app.close();
  });

  it('turns an upstream failure into 502, not 500', async () => {
    const { app, gateway, token } = await setup();
    (gateway.queryMetric as jest.Mock).mockRejectedValueOnce(new Error('GA4 indisponível'));
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token), payload: validQuery,
    });
    expect(response.statusCode).toBe(502);
    await app.close();
  });
});

describe('POST /api/metrics/batch', () => {
  it('resolves several queries at once', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/batch', headers: auth(token),
      payload: { queries: [validQuery, { ...validQuery, metricId: 'commerce.orders' }] },
    });
    expect(response.json().series).toHaveLength(2);
    await app.close();
  });

  it('rejects more than 12 queries with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/batch', headers: auth(token),
      payload: { queries: Array.from({ length: 13 }, () => validQuery) },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /api/tools/:source/:name', () => {
  it('calls an allowlisted tool with the tenant injected', async () => {
    const { app, gateway, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/tools/commerce/top_products', headers: auth(token),
      payload: { from: '2026-01-01', to: '2026-01-31', limit: 5 },
    });
    expect(response.statusCode).toBe(200);
    expect(gateway.callTool).toHaveBeenCalledWith(
      'commerce', 'top_products',
      expect.objectContaining({ tenant: expect.objectContaining({ organizationId: 'org_1' }) }),
      expect.anything(),
    );
    await app.close();
  });

  it('refuses a tool that is not on the allowlist', async () => {
    const { app, gateway, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/tools/commerce/drop_everything', headers: auth(token), payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(gateway.callTool).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses an unknown source', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/tools/mixpanel/top_products', headers: auth(token), payload: {},
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('overrides a tenant forged in the tool arguments', async () => {
    const { app, gateway, token } = await setup('org_1');
    await app.inject({
      method: 'POST', url: '/api/tools/commerce/top_products', headers: auth(token),
      payload: { from: '2026-01-01', to: '2026-01-31', tenant: { organizationId: 'org_ATACANTE', externalIds: {} } },
    });
    const args = (gateway.callTool as jest.Mock).mock.calls[0]![2] as { tenant: { organizationId: string } };
    expect(args.tenant.organizationId).toBe('org_1');
    await app.close();
  });

  it('requires a token', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/tools/commerce/top_products', payload: {} });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a periodA/periodB range longer than 400 days on compare_products', async () => {
    // C1: compare_products/compare_events recebem periodA/periodB (objetos),
    // não from/to no nível raiz — antes do fix, o handler só olhava
    // body.from/body.to e deixava esta forma passar sem nenhum teto de
    // intervalo, apesar de fazer os mesmos joins CommerceOrderItem⋈CommerceOrder.
    const { app, gateway, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/tools/commerce/compare_products', headers: auth(token),
      payload: {
        periodA: { from: '1900-01-01', to: '1900-02-01' },
        periodB: { from: '1900-01-01', to: '2100-01-01' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/400 dias/);
    expect(gateway.callTool).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /api/analysis/correlate', () => {
  it('returns the correlation result', async () => {
    const { app, gateway, token } = await setup();
    (gateway.queryBatch as jest.Mock).mockResolvedValueOnce([
      { ...series, metricId: 'ga4.active_users', unit: 'count', points: [
        { date: '2026-01-01', value: 10 }, { date: '2026-01-02', value: 20 }, { date: '2026-01-03', value: 30 },
      ] },
      { ...series, points: [
        { date: '2026-01-01', value: 100 }, { date: '2026-01-02', value: 200 }, { date: '2026-01-03', value: 300 },
      ] },
    ]);
    const response = await app.inject({
      method: 'POST', url: '/api/analysis/correlate', headers: auth(token),
      payload: {
        metricIdA: 'ga4.active_users', metricIdB: 'commerce.revenue',
        from: '2026-01-01', to: '2026-01-03', granularity: 'day',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().coefficient).toBeCloseTo(1, 5);
    expect(response.json().caveat).toBeTruthy();
    await app.close();
  });

  it('rejects correlating a metric with itself with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/analysis/correlate', headers: auth(token),
      payload: {
        metricIdA: 'commerce.revenue', metricIdB: 'commerce.revenue',
        from: '2026-01-01', to: '2026-01-31', granularity: 'day',
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an inverted date range with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/analysis/correlate', headers: auth(token),
      payload: {
        metricIdA: 'ga4.active_users', metricIdB: 'commerce.revenue',
        from: '2026-02-01', to: '2026-01-01', granularity: 'day',
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /api/analysis/app-version-impact', () => {
  const validImpactBody = { version: '5.8.0', releaseDate: '2026-01-01' };

  it('requires a token', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/analysis/app-version-impact', payload: validImpactBody,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns the impact comparison for a valid version/releaseDate', async () => {
    const { app, gateway, token } = await setup();
    (gateway.queryBatch as jest.Mock)
      .mockResolvedValueOnce([
        { ...series, metricId: 'commerce.revenue', total: 100000 },
        { ...series, metricId: 'commerce.orders', total: 50 },
        { ...series, metricId: 'ga4.active_users', total: 1000 },
      ])
      .mockResolvedValueOnce([
        { ...series, metricId: 'commerce.revenue', total: 150000 },
        { ...series, metricId: 'commerce.orders', total: 60 },
        { ...series, metricId: 'ga4.active_users', total: 1200 },
      ]);
    const response = await app.inject({
      method: 'POST', url: '/api/analysis/app-version-impact', headers: auth(token),
      payload: validImpactBody,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.version).toBe('5.8.0');
    expect(body.revenueDelta).toBe(50000);
    expect(body.caveat).toBeTruthy();
    await app.close();
  });

  it('rejects a release date in the future with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/analysis/app-version-impact', headers: auth(token),
      payload: { version: '5.8.0', releaseDate: '2099-01-01' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
