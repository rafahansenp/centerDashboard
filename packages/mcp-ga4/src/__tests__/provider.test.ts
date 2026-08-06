import type { MetricQuery } from '@center/shared';
import { createGa4Provider } from '../provider.js';
import type { Ga4ReportParams, Ga4Row } from '../client.js';
import type { Ga4ClientLike } from '../interface.js';

function fakeClient(rows: Ga4Row[]) {
  const runReport = jest.fn(async (_params: Ga4ReportParams) => rows);
  return { client: { runReport } as unknown as Ga4ClientLike, runReport };
}

const baseQuery: MetricQuery = {
  metricId: 'ga4.sessions', from: '2026-02-01', to: '2026-02-02', granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: '987654321' } },
};

describe('ga4 provider', () => {
  it('publishes the six ga4 metrics', () => {
    const { client } = fakeClient([]);
    expect(createGa4Provider(client).descriptors.map((d) => d.id).sort()).toEqual([
      'ga4.active_users', 'ga4.conversions', 'ga4.event_count',
      'ga4.new_users', 'ga4.purchase_revenue', 'ga4.sessions',
    ]);
  });

  it('always requests the date dimension so the series can be bucketed', async () => {
    const { client, runReport } = fakeClient([]);
    await createGa4Provider(client).query(baseQuery);
    expect(runReport.mock.calls[0]![0]).toMatchObject({
      propertyId: '987654321',
      metricNames: ['sessions'],
      dimensionNames: ['date'],
      from: '2026-02-01', to: '2026-02-02',
    });
  });

  it('maps each metric id to its GA4 metric name', async () => {
    const { client, runReport } = fakeClient([]);
    const provider = createGa4Provider(client);
    for (const id of ['ga4.active_users', 'ga4.new_users', 'ga4.conversions', 'ga4.purchase_revenue']) {
      await provider.query({ ...baseQuery, metricId: id });
    }
    expect(runReport.mock.calls.map((call) => call[0].metricNames[0])).toEqual([
      'activeUsers', 'newUsers', 'conversions', 'purchaseRevenue',
    ]);
  });

  it('translates canonical dimension names into GA4 names', async () => {
    const { client, runReport } = fakeClient([]);
    await createGa4Provider(client).query({
      ...baseQuery, filters: { campaign: 'black-friday' }, groupBy: 'device',
    });
    expect(runReport.mock.calls[0]![0]).toMatchObject({
      dimensionNames: ['date', 'deviceCategory'],
      dimensionFilters: { sessionCampaignName: 'black-friday' },
    });
  });

  it('converts the GA4 compact date into ISO and fills empty buckets', async () => {
    const { client } = fakeClient([
      { dimensions: { date: '20260202' }, metrics: { sessions: 42 } },
    ]);
    const series = await createGa4Provider(client).query(baseQuery);
    expect(series).toEqual({
      metricId: 'ga4.sessions', source: 'ga4', unit: 'count', granularity: 'day',
      total: 42,
      points: [{ date: '2026-02-01', value: 0 }, { date: '2026-02-02', value: 42 }],
    });
  });

  it('returns purchase revenue in cents, not in reais', async () => {
    const { client } = fakeClient([
      { dimensions: { date: '20260201' }, metrics: { purchaseRevenue: 1234.56 } },
    ]);
    const series = await createGa4Provider(client).query({ ...baseQuery, metricId: 'ga4.purchase_revenue' });
    expect(series.unit).toBe('currency');
    expect(series.total).toBe(123456);
  });

  it('groups by the requested dimension', async () => {
    const { client } = fakeClient([
      { dimensions: { date: '20260201', deviceCategory: 'mobile' }, metrics: { sessions: 30 } },
      { dimensions: { date: '20260201', deviceCategory: 'desktop' }, metrics: { sessions: 10 } },
    ]);
    const series = await createGa4Provider(client).query({
      ...baseQuery, to: '2026-02-01', groupBy: 'device',
    });
    expect(series.points).toEqual([
      { date: '2026-02-01', value: 10, group: 'desktop' },
      { date: '2026-02-01', value: 30, group: 'mobile' },
    ]);
  });

  it('refuses to query when the tenant has no GA4 property id', async () => {
    const { client } = fakeClient([]);
    await expect(createGa4Provider(client).query({
      ...baseQuery, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4PropertyId não configurado');
  });

  it('rejects an undeclared dimension with a helpful message', async () => {
    const { client } = fakeClient([]);
    await expect(createGa4Provider(client).query({ ...baseQuery, filters: { productSku: 'x' } }))
      .rejects.toThrow('dimensão não suportada: "productSku"');
  });

  it('rejects an unknown metric id', async () => {
    const { client } = fakeClient([]);
    await expect(createGa4Provider(client).query({ ...baseQuery, metricId: 'ga4.inventado' }))
      .rejects.toThrow('métrica desconhecida');
  });
});
