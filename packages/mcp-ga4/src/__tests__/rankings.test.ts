import {
  createAppVersionsTool, createCampaignUsersTool, createCompareEventsTool, createDevicePerformanceTool,
  createPagePerformanceTool, createTopEventsTool, createTrafficSourcesTool,
} from '../rankings.js';
import type { Ga4ReportParams, Ga4Row } from '../client.js';
import type { Ga4ClientLike } from '../interface.js';

function fakeClient(pages: Ga4Row[][]) {
  let call = 0;
  const runReport = jest.fn(async (_params: Ga4ReportParams) => pages[call++] ?? []);
  return { client: { runReport } as unknown as Ga4ClientLike, runReport };
}

const tenant = { organizationId: 'org_1', externalIds: { ga4PropertyId: '111' } };
const period = { from: '2026-02-01', to: '2026-02-28', tenant };

describe('traffic_sources', () => {
  it('requests sessions grouped by sourceMedium', async () => {
    const { client, runReport } = fakeClient([[]]);
    await createTrafficSourcesTool(client).handler(period);
    expect(runReport.mock.calls[0]![0]).toMatchObject({
      dimensionNames: ['sessionSourceMedium'],
      metricNames: ['sessions', 'activeUsers'],
    });
  });

  it('ranks by users and reports sessions as extra', async () => {
    const { client } = fakeClient([[
      { dimensions: { sessionSourceMedium: 'google / organic' }, metrics: { sessions: 300, activeUsers: 200 } },
      { dimensions: { sessionSourceMedium: 'facebook / cpc' }, metrics: { sessions: 100, activeUsers: 80 } },
    ]]);
    const result = await createTrafficSourcesTool(client).handler(period) as { rows: Array<Record<string, unknown>> };
    expect(result.rows[0]).toMatchObject({ key: 'google / organic', value: 200 });
    expect(result.rows[0]?.extra).toMatchObject({ sessions: 300 });
  });

  it('computes each share of the period total', async () => {
    const { client } = fakeClient([[
      { dimensions: { sessionSourceMedium: 'a' }, metrics: { sessions: 0, activeUsers: 75 } },
      { dimensions: { sessionSourceMedium: 'b' }, metrics: { sessions: 0, activeUsers: 25 } },
    ]]);
    const result = await createTrafficSourcesTool(client).handler(period) as { rows: Array<{ share: number }> };
    expect(result.rows[0]?.share).toBeCloseTo(0.75, 5);
  });

  it('respects the limit', async () => {
    const { client } = fakeClient([[
      { dimensions: { sessionSourceMedium: 'a' }, metrics: { activeUsers: 3, sessions: 3 } },
      { dimensions: { sessionSourceMedium: 'b' }, metrics: { activeUsers: 2, sessions: 2 } },
      { dimensions: { sessionSourceMedium: 'c' }, metrics: { activeUsers: 1, sessions: 1 } },
    ]]);
    const result = await createTrafficSourcesTool(client).handler({ ...period, limit: 2 }) as { rows: unknown[] };
    expect(result.rows).toHaveLength(2);
  });

  it('refuses without a GA4 property id', async () => {
    const { client } = fakeClient([[]]);
    await expect(createTrafficSourcesTool(client).handler({
      ...period, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4PropertyId não configurado');
  });
});

describe('campaign_users', () => {
  it('groups by campaign name', async () => {
    const { client, runReport } = fakeClient([[]]);
    await createCampaignUsersTool(client).handler(period);
    expect(runReport.mock.calls[0]![0].dimensionNames).toEqual(['sessionCampaignName']);
  });
});

describe('device_performance', () => {
  it('reports sessions, users and conversion rate per device', async () => {
    const { client } = fakeClient([[
      { dimensions: { deviceCategory: 'mobile' }, metrics: { sessions: 1000, activeUsers: 800, conversions: 50 } },
      { dimensions: { deviceCategory: 'desktop' }, metrics: { sessions: 200, activeUsers: 150, conversions: 20 } },
    ]]);
    const result = await createDevicePerformanceTool(client).handler(period) as { rows: Array<Record<string, unknown>> };
    // desktop converte 10%, mobile 5% — desktop lidera mesmo com menos tráfego.
    expect(result.rows[0]?.key).toBe('desktop');
    expect(result.rows[0]?.value).toBeCloseTo(0.1, 5);
  });

  it('does not divide by zero for a device with no sessions', async () => {
    const { client } = fakeClient([[
      { dimensions: { deviceCategory: 'tablet' }, metrics: { sessions: 0, activeUsers: 0, conversions: 0 } },
    ]]);
    const result = await createDevicePerformanceTool(client).handler(period) as { rows: Array<{ value: number }> };
    expect(result.rows[0]?.value).toBe(0);
  });
});

describe('page_performance', () => {
  it('ranks pages by bounce rate so the worst page surfaces first', async () => {
    const { client } = fakeClient([[
      { dimensions: { pagePath: '/checkout' }, metrics: { screenPageViews: 500, bounceRate: 0.8 } },
      { dimensions: { pagePath: '/home' }, metrics: { screenPageViews: 2000, bounceRate: 0.2 } },
    ]]);
    const result = await createPagePerformanceTool(client).handler(period) as { rows: Array<Record<string, unknown>> };
    expect(result.rows[0]).toMatchObject({ key: '/checkout', value: 0.8 });
    expect(result.rows[0]?.extra).toMatchObject({ pageViews: 500 });
  });
});

describe('app_versions', () => {
  it('filters to app platforms and groups by version', async () => {
    const { client, runReport } = fakeClient([[]]);
    await createAppVersionsTool(client).handler(period);
    expect(runReport.mock.calls[0]![0]).toMatchObject({
      dimensionNames: ['appVersion'],
      metricNames: ['activeUsers', 'sessions'],
    });
  });

  it('ignores the empty version bucket that web traffic produces', async () => {
    const { client } = fakeClient([[
      { dimensions: { appVersion: '' }, metrics: { activeUsers: 900, sessions: 1000 } },
      { dimensions: { appVersion: '5.8.0' }, metrics: { activeUsers: 500, sessions: 700 } },
    ]]);
    const result = await createAppVersionsTool(client).handler(period) as { rows: Array<{ key: string }> };
    expect(result.rows.map((r) => r.key)).toEqual(['5.8.0']);
  });
});

describe('top_events', () => {
  it('ranks events by count', async () => {
    const { client } = fakeClient([[
      { dimensions: { eventName: 'page_view' }, metrics: { eventCount: 5000 } },
      { dimensions: { eventName: 'purchase' }, metrics: { eventCount: 120 } },
    ]]);
    const result = await createTopEventsTool(client).handler(period) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows[0]).toMatchObject({ key: 'page_view', value: 5000 });
  });
});

describe('compare_events', () => {
  const comparison = {
    tenant,
    periodA: { from: '2026-01-01', to: '2026-01-31' },
    periodB: { from: '2026-02-01', to: '2026-02-28' },
  };

  it('reports the delta per event, biggest growth first', async () => {
    const { client } = fakeClient([
      [{ dimensions: { eventName: 'add_to_cart' }, metrics: { eventCount: 100 } },
       { dimensions: { eventName: 'purchase' }, metrics: { eventCount: 50 } }],
      [{ dimensions: { eventName: 'add_to_cart' }, metrics: { eventCount: 400 } },
       { dimensions: { eventName: 'purchase' }, metrics: { eventCount: 40 } }],
    ]);
    const result = await createCompareEventsTool(client).handler(comparison) as { rows: Array<Record<string, unknown>> };
    expect(result.rows[0]).toMatchObject({ key: 'add_to_cart', valueA: 100, valueB: 400, delta: 300 });
    expect(result.rows[0]?.deltaRatio).toBeCloseTo(3, 5);
  });

  it('reports a null ratio for an event absent from period A', async () => {
    const { client } = fakeClient([
      [],
      [{ dimensions: { eventName: 'novo_evento' }, metrics: { eventCount: 90 } }],
    ]);
    const result = await createCompareEventsTool(client).handler(comparison) as { rows: Array<{ deltaRatio: number | null }> };
    expect(result.rows[0]?.deltaRatio).toBeNull();
  });

  it('includes events that disappeared in period B', async () => {
    const { client } = fakeClient([
      [{ dimensions: { eventName: 'sumiu' }, metrics: { eventCount: 70 } }],
      [],
    ]);
    const result = await createCompareEventsTool(client).handler(comparison) as { rows: Array<{ key: string; delta: number }> };
    expect(result.rows.find((r) => r.key === 'sumiu')?.delta).toBe(-70);
  });
});
