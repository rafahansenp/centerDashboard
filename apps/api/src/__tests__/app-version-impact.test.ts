import type { MetricSeries } from '@center/shared';
import type { MetricGateway } from '@center/mcp-core';
import { analyzeAppVersionImpact } from '../analysis/app-version-impact.js';

const tenant = { organizationId: 'org_1', externalIds: { ga4PropertyId: '111' } };

function series(metricId: string, total: number, unit: MetricSeries['unit'] = 'count'): MetricSeries {
  return {
    metricId, source: metricId.startsWith('commerce') ? 'commerce' : 'ga4',
    unit, granularity: 'day', total,
    points: [{ date: '2026-02-01', value: total }],
  };
}

/** Devolve valores diferentes conforme a janela pedida (antes vs. depois). */
function fakeGateway(before: Record<string, number>, after: Record<string, number>, adoptionRows = 0) {
  const queryBatch = jest.fn(async (queries: Array<{ metricId: string; from: string }>) =>
    queries.map((query) => {
      const window = query.from < '2026-02-01' ? before : after;
      const unit = query.metricId === 'commerce.revenue' ? 'currency' : 'count';
      return series(query.metricId, window[query.metricId] ?? 0, unit);
    }));

  const callTool = jest.fn(async () => ({
    rows: adoptionRows === 0 ? [] : [
      { key: '5.8.0', label: '5.8.0', value: adoptionRows, unit: 'count', extra: {}, share: 0.6 },
      { key: '5.7.0', label: '5.7.0', value: 100, unit: 'count', extra: {}, share: 0.4 },
    ],
  }));

  return { gateway: { queryBatch, callTool } as unknown as MetricGateway, queryBatch, callTool };
}

const base = {
  tenant, version: '5.8.0', releaseDate: '2026-02-01',
  windowDays: 14, today: '2026-03-01',
};

describe('analyzeAppVersionImpact', () => {
  it('compares symmetric windows around the release date', async () => {
    const { gateway, queryBatch } = fakeGateway(
      { 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 },
    );
    await analyzeAppVersionImpact({ gateway, ...base });

    const froms = queryBatch.mock.calls.flatMap((call) => call[0].map((q) => `${q.from}`));
    // 14 dias antes: 2026-01-18 a 2026-01-31. 14 dias depois: 2026-02-01 a 2026-02-14.
    expect(froms).toContain('2026-01-18');
    expect(froms).toContain('2026-02-01');
  });

  it('reports the revenue delta and its ratio', async () => {
    const { gateway } = fakeGateway(
      { 'commerce.revenue': 100000, 'commerce.orders': 50, 'ga4.active_users': 1000 },
      { 'commerce.revenue': 150000, 'commerce.orders': 60, 'ga4.active_users': 1200 },
    );
    const result = await analyzeAppVersionImpact({ gateway, ...base });
    expect(result.revenueDelta).toBe(50000);
    expect(result.revenueDeltaRatio).toBeCloseTo(0.5, 5);
    expect(result.ordersDelta).toBe(10);
    expect(result.usersDelta).toBe(200);
  });

  it('judges a meaningful rise as "melhorou"', async () => {
    const { gateway } = fakeGateway({ 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 });
    expect((await analyzeAppVersionImpact({ gateway, ...base })).verdict).toBe('melhorou');
  });

  it('judges a meaningful drop as "piorou"', async () => {
    const { gateway } = fakeGateway({ 'commerce.revenue': 150000 }, { 'commerce.revenue': 100000 });
    expect((await analyzeAppVersionImpact({ gateway, ...base })).verdict).toBe('piorou');
  });

  it('judges a change under the relevance threshold as no real change', async () => {
    // 2% de variação não sustenta afirmar que a atualização mudou as vendas.
    const { gateway } = fakeGateway({ 'commerce.revenue': 100000 }, { 'commerce.revenue': 102000 });
    expect((await analyzeAppVersionImpact({ gateway, ...base })).verdict).toBe('sem-mudanca-relevante');
  });

  it('is inconclusive when there was no revenue before the release', async () => {
    const { gateway } = fakeGateway({ 'commerce.revenue': 0 }, { 'commerce.revenue': 90000 });
    const result = await analyzeAppVersionImpact({ gateway, ...base });
    expect(result.verdict).toBe('inconclusivo');
    expect(result.revenueDeltaRatio).toBeNull();
  });

  it('is inconclusive when the after window has not fully elapsed', async () => {
    const result = await analyzeAppVersionImpact({
      gateway: fakeGateway({ 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 }).gateway,
      ...base, releaseDate: '2026-02-25', today: '2026-03-01',
    });
    // Só 5 dias desde o lançamento contra uma janela de 14: comparar seria injusto.
    expect(result.verdict).toBe('inconclusivo');
  });

  it('reports the adoption share of the version', async () => {
    const { gateway } = fakeGateway(
      { 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 }, 150,
    );
    const result = await analyzeAppVersionImpact({ gateway, ...base });
    expect(result.adoption).toMatchObject({ users: 150, share: 0.6 });
  });

  it('reports null adoption when the version never appears in GA4', async () => {
    const { gateway } = fakeGateway({ 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 }, 0);
    expect((await analyzeAppVersionImpact({ gateway, ...base })).adoption).toBeNull();
  });

  it('always carries the causality caveat', async () => {
    const { gateway } = fakeGateway({ 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 });
    const result = await analyzeAppVersionImpact({ gateway, ...base });
    expect(result.caveat).toMatch(/outros fatores/i);
  });

  it('rejects a release date in the future', async () => {
    const { gateway } = fakeGateway({}, {});
    await expect(analyzeAppVersionImpact({
      gateway, ...base, releaseDate: '2026-06-01', today: '2026-03-01',
    })).rejects.toThrow('data de lançamento no futuro');
  });
});
