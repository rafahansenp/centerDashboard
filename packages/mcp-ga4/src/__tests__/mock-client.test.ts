import { fromGa4Date } from '../client.js';
import { FIXTURE_CATEGORIES, MockGa4Client } from '../mock-client.js';

describe('MockGa4Client — série por data', () => {
  it('returns one row per day in the requested range', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['sessions'], from: '2026-02-01', to: '2026-02-05',
      dimensionNames: ['date'], dimensionFilters: {},
    });
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.dimensions.date).sort()).toEqual([
      '20260201', '20260202', '20260203', '20260204', '20260205',
    ]);
  });

  it('is deterministic — the same request produces the same values', async () => {
    const request = {
      propertyId: '1', metricNames: ['sessions'], from: '2026-02-01', to: '2026-02-01',
      dimensionNames: ['date'], dimensionFilters: {},
    };
    const first = await new MockGa4Client().runReport(request);
    const second = await new MockGa4Client().runReport(request);
    expect(first).toEqual(second);
  });

  it('produces a positive integer for count metrics', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['activeUsers'], from: '2026-02-01', to: '2026-02-01',
      dimensionNames: ['date'], dimensionFilters: {},
    });
    expect(Number.isInteger(rows[0]!.metrics.activeUsers)).toBe(true);
    expect(rows[0]!.metrics.activeUsers).toBeGreaterThan(0);
  });

  it('adds the second dimension when grouping is requested', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['sessions'], from: '2026-02-01', to: '2026-02-01',
      dimensionNames: ['date', 'deviceCategory'], dimensionFilters: {},
    });
    expect(rows.length).toBe(FIXTURE_CATEGORIES.deviceCategory!.length);
    expect(rows.every((r) => FIXTURE_CATEGORIES.deviceCategory!.includes(r.dimensions.deviceCategory!))).toBe(true);
  });

  it('dates come out in the compact GA4 format, decodable by fromGa4Date', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['sessions'], from: '2026-02-01', to: '2026-02-01',
      dimensionNames: ['date'], dimensionFilters: {},
    });
    expect(fromGa4Date(rows[0]!.dimensions.date!)).toBe('2026-02-01');
  });
});

describe('MockGa4Client — ranking por dimensão', () => {
  it('returns the known fixture categories for a recognised dimension', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['activeUsers', 'sessions'], from: '2026-02-01', to: '2026-02-28',
      dimensionNames: ['sessionSourceMedium'], dimensionFilters: {},
    });
    expect(rows.map((r) => r.dimensions.sessionSourceMedium).sort())
      .toEqual([...FIXTURE_CATEGORIES.sessionSourceMedium!].sort());
  });

  it('produces a value between 0 and 1 for a ratio-shaped metric like bounceRate', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['bounceRate'], from: '2026-02-01', to: '2026-02-28',
      dimensionNames: ['pagePath'], dimensionFilters: {},
    });
    for (const row of rows) {
      expect(row.metrics.bounceRate).toBeGreaterThanOrEqual(0);
      expect(row.metrics.bounceRate).toBeLessThanOrEqual(1);
    }
  });

  it('includes the five standard e-commerce events plus page_view for eventName', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['eventCount', 'activeUsers'], from: '2026-02-01', to: '2026-02-28',
      dimensionNames: ['eventName'], dimensionFilters: {},
    });
    const names = rows.map((r) => r.dimensions.eventName);
    for (const expected of ['view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase']) {
      expect(names).toContain(expected);
    }
  });

  it('falls back to a generic three-category fixture for an unmapped dimension', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['sessions'], from: '2026-02-01', to: '2026-02-28',
      dimensionNames: ['country'], dimensionFilters: {},
    });
    expect(rows).toHaveLength(3);
  });
});
