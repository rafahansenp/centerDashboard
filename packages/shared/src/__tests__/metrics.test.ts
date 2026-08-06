import { MetricQuerySchema } from '../metrics.js';
import { RankingResultSchema, FunnelResultSchema } from '../rankings.js';

const validQuery = {
  metricId: 'commerce.revenue',
  from: '2026-01-01',
  to: '2026-01-31',
  granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: '111' } },
};

describe('MetricQuerySchema', () => {
  it('accepts a well formed query', () => {
    expect(MetricQuerySchema.parse(validQuery).metricId).toBe('commerce.revenue');
  });

  it('rejects a non ISO date', () => {
    expect(MetricQuerySchema.safeParse({ ...validQuery, from: '01/01/2026' }).success).toBe(false);
  });

  it('rejects a query without a tenant', () => {
    const { tenant: _omitted, ...withoutTenant } = validQuery;
    expect(MetricQuerySchema.safeParse(withoutTenant).success).toBe(false);
  });

  it('rejects an unknown granularity', () => {
    expect(MetricQuerySchema.safeParse({ ...validQuery, granularity: 'hour' }).success).toBe(false);
  });
});

describe('RankingResultSchema', () => {
  it('defaults extra to an empty object', () => {
    const parsed = RankingResultSchema.parse({
      dimension: 'product', from: '2026-01-01', to: '2026-01-31',
      total: 1000, unit: 'currency',
      rows: [{ key: 'SKU1', label: 'Camiseta', value: 600, unit: 'currency', share: 0.6 }],
    });
    expect(parsed.rows[0]?.extra).toEqual({});
  });

  it('rejects a share outside 0..1', () => {
    const result = RankingResultSchema.safeParse({
      dimension: 'product', from: '2026-01-01', to: '2026-01-31',
      total: 1000, unit: 'currency',
      rows: [{ key: 'SKU1', label: 'X', value: 600, unit: 'currency', share: 1.4 }],
    });
    expect(result.success).toBe(false);
  });
});

describe('FunnelResultSchema', () => {
  it('accepts a null stepConversion on the first step', () => {
    const parsed = FunnelResultSchema.parse({
      from: '2026-01-01', to: '2026-01-31',
      steps: [
        { key: 'view_item', label: 'Viu produto', users: 1000, stepConversion: null, dropOff: 0 },
        { key: 'purchase', label: 'Comprou', users: 100, stepConversion: 0.1, dropOff: 900 },
      ],
      worstStepKey: 'purchase',
      overallConversion: 0.1,
    });
    expect(parsed.steps[0]?.stepConversion).toBeNull();
  });
});
