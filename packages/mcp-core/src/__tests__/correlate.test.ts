import type { MetricSeries } from '@center/shared';
import { correlateMetrics, describeStrength, pearson } from '../correlate.js';
import type { MetricGateway } from '../gateway.js';

describe('pearson', () => {
  it('returns 1 for a perfectly increasing pair', () => {
    expect(pearson([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 6);
  });

  it('returns -1 for a perfectly inverse pair', () => {
    expect(pearson([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 6);
  });

  it('returns roughly zero for unrelated series', () => {
    expect(Math.abs(pearson([1, 2, 3, 4], [5, 5.1, 4.9, 5]) ?? 1)).toBeLessThan(0.5);
  });

  it('returns null when one series has no variance', () => {
    expect(pearson([1, 2, 3], [7, 7, 7])).toBeNull();
  });

  it('returns null for fewer than three points', () => {
    expect(pearson([1, 2], [3, 4])).toBeNull();
  });

  it('returns null when the lengths differ', () => {
    expect(pearson([1, 2, 3], [1, 2])).toBeNull();
  });
});

describe('describeStrength', () => {
  it.each([
    [0.9, 'forte'], [-0.85, 'forte'],
    [0.6, 'moderada'], [-0.55, 'moderada'],
    [0.35, 'fraca'], [-0.3, 'fraca'],
    [0.1, 'desprezivel'], [0, 'desprezivel'],
  ])('classifies %s as %s', (coefficient, expected) => {
    expect(describeStrength(coefficient)).toBe(expected);
  });

  it('classifies null as indeterminada', () => {
    expect(describeStrength(null)).toBe('indeterminada');
  });
});

const tenant = { organizationId: 'org_1', externalIds: {} };

function series(metricId: string, values: number[], unit: MetricSeries['unit'] = 'count'): MetricSeries {
  return {
    metricId,
    source: metricId.startsWith('commerce') ? 'commerce' : 'ga4',
    unit,
    granularity: 'day',
    total: values.reduce((acc, value) => acc + value, 0),
    points: values.map((value, index) => ({
      date: `2026-02-${String(index + 1).padStart(2, '0')}`, value,
    })),
  };
}

function fakeGateway(map: Record<string, MetricSeries>) {
  const queryBatch = jest.fn(async (queries: Array<{ metricId: string }>) =>
    queries.map((query) => map[query.metricId]!));
  return { gateway: { queryBatch } as unknown as MetricGateway, queryBatch };
}

const input = {
  metricIdA: 'ga4.active_users',
  metricIdB: 'commerce.revenue',
  from: '2026-02-01', to: '2026-02-05',
  granularity: 'day' as const,
  tenant,
};

describe('correlateMetrics', () => {
  it('fetches both series in a single batch', async () => {
    const { gateway, queryBatch } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [100, 200, 300, 400, 500], 'currency'),
    });
    await correlateMetrics(gateway, input);
    expect(queryBatch).toHaveBeenCalledTimes(1);
    expect(queryBatch.mock.calls[0]![0]).toHaveLength(2);
  });

  it('reports a strong positive correlation', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [100, 200, 300, 400, 500], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.coefficient).toBeCloseTo(1, 6);
    expect(result.strength).toBe('forte');
    expect(result.direction).toBe('positiva');
  });

  it('reports a negative direction when one metric falls as the other rises', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [500, 400, 300, 200, 100], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.direction).toBe('negativa');
    expect(result.coefficient).toBeCloseTo(-1, 6);
  });

  it('aligns the two series by bucket date', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [100, 200, 300, 400, 500], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.series).toHaveLength(5);
    expect(result.series[0]).toEqual({ date: '2026-02-01', valueA: 10, valueB: 100 });
  });

  it('drops buckets present in only one series instead of pairing them wrongly', async () => {
    const short = series('commerce.revenue', [100, 200, 300], 'currency');
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': short,
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.buckets).toBe(3);
  });

  it('pairs by date, not by array position, when the shared dates are not a prefix', async () => {
    const revenue = series('commerce.revenue', [100, 200, 300, 400, 500], 'currency');
    // Only 2026-02-02, -03 and -05 survive — a positional zip of the first 3
    // points from each series would silently pair 01/02/03 instead.
    const sparse: MetricSeries = {
      ...revenue,
      points: [revenue.points[1]!, revenue.points[2]!, revenue.points[4]!],
      total: 200 + 300 + 500,
    };
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': sparse,
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.buckets).toBe(3);
    expect(result.series).toEqual([
      { date: '2026-02-02', valueA: 20, valueB: 200 },
      { date: '2026-02-03', valueA: 30, valueB: 300 },
      { date: '2026-02-05', valueA: 50, valueB: 500 },
    ]);
  });

  it('returns an indeterminate result when a metric never changes', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [7, 7, 7, 7, 7], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.coefficient).toBeNull();
    expect(result.strength).toBe('indeterminada');
    expect(result.direction).toBe('indefinida');
  });

  it('returns an indeterminate result for a period too short to correlate', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20]),
      'commerce.revenue': series('commerce.revenue', [100, 200], 'currency'),
    });
    const result = await correlateMetrics(gateway, { ...input, to: '2026-02-02' });
    expect(result.coefficient).toBeNull();
    expect(result.strength).toBe('indeterminada');
  });

  it('always carries the causality caveat', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [100, 200, 300, 400, 500], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.caveat).toMatch(/não (implica|prova) causa/i);
  });

  it('reports the totals and units of both metrics', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [100, 200, 300, 400, 500], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.metricA).toMatchObject({ id: 'ga4.active_users', unit: 'count', total: 150 });
    expect(result.metricB).toMatchObject({ id: 'commerce.revenue', unit: 'currency', total: 1500 });
  });

  it('rejects correlating a metric with itself', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
    });
    await expect(correlateMetrics(gateway, { ...input, metricIdB: 'ga4.active_users' }))
      .rejects.toThrow('correlacionar uma métrica com ela mesma');
  });
});
