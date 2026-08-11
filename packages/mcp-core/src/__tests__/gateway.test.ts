import type { MetricQuery, MetricSeries } from '@center/shared';
import { MemoryCacheStore, cacheKeyFor, toolCacheKeyFor } from '../cache.js';
import { MetricGateway } from '../gateway.js';
import type { McpPool } from '../pool.js';

const query: MetricQuery = {
  metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-31',
  granularity: 'day', tenant: { organizationId: 'org_1', externalIds: {} },
};

const series: MetricSeries = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency',
  granularity: 'day', total: 100000, points: [{ date: '2026-01-01', value: 100000 }],
};

function fakePool() {
  const queryMetric = jest.fn(async () => series);
  const listMetrics = jest.fn(async () => []);
  const callTool = jest.fn(async () => ({ rows: [] }));
  const close = jest.fn(async () => {});
  return {
    pool: { queryMetric, listMetrics, callTool, close } as unknown as McpPool,
    queryMetric, listMetrics, callTool,
  };
}

/** "Hoje" fixo em 2026-03-15 — o range acima está inteiramente no passado. */
const now = () => new Date('2026-03-15T12:00:00Z');

describe('cacheKeyFor', () => {
  it('is stable across filter key ordering', () => {
    expect(cacheKeyFor({ ...query, filters: { a: '1', b: '2' } }))
      .toBe(cacheKeyFor({ ...query, filters: { b: '2', a: '1' } }));
  });

  it('separates tenants', () => {
    expect(cacheKeyFor(query)).not.toBe(cacheKeyFor({
      ...query, tenant: { organizationId: 'org_2', externalIds: {} },
    }));
  });

  it('separates date ranges', () => {
    expect(cacheKeyFor(query)).not.toBe(cacheKeyFor({ ...query, to: '2026-02-28' }));
  });

  it('is namespaced so a targeted purge is possible', () => {
    expect(cacheKeyFor(query)).toMatch(/^metric:v1:org_1:/);
  });
});

describe('toolCacheKeyFor', () => {
  it('separates tools, arguments and tenants', () => {
    const base = toolCacheKeyFor('commerce', 'top_products', { limit: 10 }, 'org_1');
    expect(base).not.toBe(toolCacheKeyFor('commerce', 'top_products', { limit: 20 }, 'org_1'));
    expect(base).not.toBe(toolCacheKeyFor('commerce', 'top_categories', { limit: 10 }, 'org_1'));
    expect(base).not.toBe(toolCacheKeyFor('commerce', 'top_products', { limit: 10 }, 'org_2'));
  });

  it('ignores the tenant object inside the arguments when keying', () => {
    const withTenant = toolCacheKeyFor(
      'commerce', 'top_products',
      { limit: 10, tenant: { organizationId: 'org_1', externalIds: { secret: 'a' } } }, 'org_1',
    );
    const withoutTenant = toolCacheKeyFor('commerce', 'top_products', { limit: 10 }, 'org_1');
    expect(withTenant).toBe(withoutTenant);
  });
});

describe('MetricGateway', () => {
  it('hits the pool on a cache miss', async () => {
    const { pool, queryMetric } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    expect(await gateway.queryMetric(query)).toEqual(series);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('serves the second identical query from cache', async () => {
    const { pool, queryMetric } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    await gateway.queryMetric(query);
    await gateway.queryMetric(query);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('does not share cache between tenants', async () => {
    const { pool, queryMetric } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    await gateway.queryMetric(query);
    await gateway.queryMetric({ ...query, tenant: { organizationId: 'org_2', externalIds: {} } });
    expect(queryMetric).toHaveBeenCalledTimes(2);
  });

  it('uses a long TTL for a range entirely in the past', async () => {
    const { pool } = fakePool();
    const cache = new MemoryCacheStore();
    const setSpy = jest.spyOn(cache, 'set');
    await new MetricGateway(pool, cache, { now }).queryMetric(query);
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 86_400);
  });

  it('uses a short TTL when the range includes today', async () => {
    const { pool } = fakePool();
    const cache = new MemoryCacheStore();
    const setSpy = jest.spyOn(cache, 'set');
    await new MetricGateway(pool, cache, { now }).queryMetric({ ...query, to: '2026-03-31' });
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 300);
  });

  it('resolves "today" in São Paulo, not UTC, when choosing the TTL', async () => {
    // 2026-03-16T01:30:00Z é 2026-03-15 22:30 em São Paulo: o UTC já virou o
    // dia, São Paulo não. Um intervalo terminando em 2026-03-15 ainda alcança
    // hoje e continua sendo escrito pelas fontes.
    //
    // Com a comparação feita em UTC, este intervalo era classificado como
    // período fechado e cacheado por 24h — congelando "quanto vendemos hoje?"
    // todo dia entre 21h e meia-noite, e mantendo a resposta errada no dia
    // seguinte, já que "ontem" resolve para o mesmo from/to e a mesma chave.
    const { pool } = fakePool();
    const cache = new MemoryCacheStore();
    const setSpy = jest.spyOn(cache, 'set');
    const lateEvening = () => new Date('2026-03-16T01:30:00Z');

    await new MetricGateway(pool, cache, { now: lateEvening })
      .queryMetric({ ...query, to: '2026-03-15' });

    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 300);
  });

  it('still uses a long TTL for a period closed in São Paulo terms', async () => {
    // Mesmo instante do teste acima; só o intervalo muda. Garante que a
    // correção não transformou todo TTL em curto.
    const { pool } = fakePool();
    const cache = new MemoryCacheStore();
    const setSpy = jest.spyOn(cache, 'set');
    const lateEvening = () => new Date('2026-03-16T01:30:00Z');

    await new MetricGateway(pool, cache, { now: lateEvening })
      .queryMetric({ ...query, to: '2026-03-14' });

    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 86_400);
  });

  it('caches named analysis tools too', async () => {
    const { pool, callTool } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    await gateway.callTool('commerce', 'top_products', { from: '2026-01-01', to: '2026-01-31', limit: 10 });
    await gateway.callTool('commerce', 'top_products', { from: '2026-01-01', to: '2026-01-31', limit: 10 });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('skips the cache for a tool marked as uncacheable', async () => {
    const { pool, callTool } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    await gateway.callTool('commerce', 'failed_orders', {}, { cache: false });
    await gateway.callTool('commerce', 'failed_orders', {}, { cache: false });
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('falls through to the pool when the cached payload is corrupt', async () => {
    const { pool, queryMetric } = fakePool();
    const cache = new MemoryCacheStore();
    await cache.set(cacheKeyFor(query), '{not json', 60);
    expect(await new MetricGateway(pool, cache, { now }).queryMetric(query)).toEqual(series);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('still answers when the cache backend is down', async () => {
    const { pool, queryMetric } = fakePool();
    const broken = {
      get: jest.fn(async () => { throw new Error('ECONNREFUSED'); }),
      set: jest.fn(async () => { throw new Error('ECONNREFUSED'); }),
    };
    expect(await new MetricGateway(pool, broken, { now }).queryMetric(query)).toEqual(series);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('resolves a batch preserving input order', async () => {
    const { pool } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    const results = await gateway.queryBatch([query, { ...query, metricId: 'commerce.orders' }]);
    expect(results).toHaveLength(2);
    expect(results[0]?.metricId).toBe('commerce.revenue');
  });
});
