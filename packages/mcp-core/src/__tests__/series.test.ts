import type { MetricQuery } from '@center/shared';
import { toSeries, type SeriesRow } from '../series.js';

const query: MetricQuery = {
  metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-03',
  granularity: 'day', tenant: { organizationId: 'org_1', externalIds: {} },
};

describe('toSeries', () => {
  it('fills missing buckets with zero so charts have no gaps', () => {
    const rows: SeriesRow[] = [{ date: '2026-01-02', value: 500, group: null }];
    expect(toSeries(rows, query, 'currency', 'commerce').points).toEqual([
      { date: '2026-01-01', value: 0 },
      { date: '2026-01-02', value: 500 },
      { date: '2026-01-03', value: 0 },
    ]);
  });

  it('collapses daily rows into month buckets', () => {
    const rows: SeriesRow[] = [
      { date: '2026-01-05', value: 1000, group: null },
      { date: '2026-01-20', value: 1500, group: null },
    ];
    const series = toSeries(rows, { ...query, to: '2026-01-31', granularity: 'month' }, 'currency', 'commerce');
    expect(series.points).toEqual([{ date: '2026-01-01', value: 2500 }]);
    expect(series.total).toBe(2500);
  });

  it('keeps grouped rows separate and deterministically sorted', () => {
    const rows: SeriesRow[] = [
      { date: '2026-01-01', value: 600, group: 'pix' },
      { date: '2026-01-01', value: 400, group: 'cartao' },
    ];
    const series = toSeries(rows, { ...query, to: '2026-01-01', groupBy: 'paymentMethod' }, 'currency', 'commerce');
    expect(series.points).toEqual([
      { date: '2026-01-01', value: 400, group: 'cartao' },
      { date: '2026-01-01', value: 600, group: 'pix' },
    ]);
    expect(series.total).toBe(1000);
  });

  it('sums two rows landing in the same bucket', () => {
    const rows: SeriesRow[] = [
      { date: '2026-01-01', value: 300, group: null },
      { date: '2026-01-01', value: 400, group: null },
    ];
    expect(toSeries(rows, { ...query, to: '2026-01-01' }, 'currency', 'commerce').total).toBe(700);
  });

  it('produces an all-zero series when there are no rows', () => {
    const series = toSeries([], query, 'currency', 'commerce');
    expect(series.total).toBe(0);
    expect(series.points).toHaveLength(3);
  });
});
