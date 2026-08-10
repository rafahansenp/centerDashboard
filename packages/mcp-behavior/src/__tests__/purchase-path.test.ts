import { assertDatasetName } from '../client.js';
import { buildPurchasePathSql, createEventsBeforePurchaseTool } from '../purchase-path.js';
import type { BigQueryEventsClientLike } from '../interface.js';

function fakeClient(rows: unknown[]) {
  const query = jest.fn(async () => rows);
  return { client: { query } as unknown as BigQueryEventsClientLike, query };
}

const tenant = {
  organizationId: 'org_1',
  externalIds: { ga4BigQueryDataset: 'analytics_123456' },
};

const period = { from: '2026-02-01', to: '2026-02-28', tenant };

describe('assertDatasetName', () => {
  it('accepts a well formed GA4 dataset name', () => {
    expect(assertDatasetName('analytics_123456')).toBe('analytics_123456');
  });

  it('accepts a project qualified name', () => {
    expect(assertDatasetName('meu-projeto.analytics_123456')).toBe('meu-projeto.analytics_123456');
  });

  it('rejects a name with a backtick — SQL injection vector', () => {
    expect(() => assertDatasetName('analytics`; DROP TABLE x; --')).toThrow('dataset inválido');
  });

  it('rejects a name with spaces or quotes', () => {
    expect(() => assertDatasetName('analytics 123')).toThrow('dataset inválido');
    expect(() => assertDatasetName("analytics'")).toThrow('dataset inválido');
  });
});

describe('buildPurchasePathSql', () => {
  it('reads from the events_* wildcard table of the dataset', () => {
    const sql = buildPurchasePathSql({ dataset: 'analytics_123456', lookback: 10 });
    expect(sql).toContain('`analytics_123456.events_*`');
  });

  it('filters the partition by _TABLE_SUFFIX to keep the scan cheap', () => {
    // Sem este filtro a query varre TODO o histórico e a conta do BigQuery explode.
    const sql = buildPurchasePathSql({ dataset: 'analytics_123456', lookback: 10 });
    expect(sql).toContain('_TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact');
  });

  it('uses named parameters instead of interpolating dates', () => {
    const sql = buildPurchasePathSql({ dataset: 'analytics_123456', lookback: 10 });
    expect(sql).toContain('@fromCompact');
    expect(sql).toContain('@toCompact');
    expect(sql).not.toMatch(/\d{8}/);
  });

  it('embeds the lookback as a literal integer, never as raw text', () => {
    expect(buildPurchasePathSql({ dataset: 'analytics_123456', lookback: 7 })).toContain('<= 7');
  });
});

describe('events_before_purchase', () => {
  it('is named events_before_purchase', () => {
    expect(createEventsBeforePurchaseTool(fakeClient([]).client).name).toBe('events_before_purchase');
  });

  it('converts the ISO dates into the GA4 compact suffix format', async () => {
    const { client, query } = fakeClient([]);
    await createEventsBeforePurchaseTool(client).handler(period);
    expect(query.mock.calls[0]![1]).toMatchObject({ fromCompact: '20260201', toCompact: '20260228' });
  });

  it('maps rows into events ordered by how often they precede a purchase', async () => {
    const { client } = fakeClient([
      { event_name: 'add_to_cart', users: 800, purchases: 1000, avg_position: 2.1 },
      { event_name: 'view_item', users: 950, purchases: 1000, avg_position: 4.7 },
    ]);
    const result = await createEventsBeforePurchaseTool(client).handler(period) as {
      totalPurchases: number; events: Array<Record<string, number | string>>;
    };
    expect(result.totalPurchases).toBe(1000);
    expect(result.events[0]).toMatchObject({ evento: 'view_item', usuarios: 950 });
    expect(result.events[0]?.frequencia).toBeCloseTo(0.95, 5);
  });

  it('sorts by frequency descending', async () => {
    const { client } = fakeClient([
      { event_name: 'raro', users: 10, purchases: 1000, avg_position: 1 },
      { event_name: 'comum', users: 900, purchases: 1000, avg_position: 3 },
    ]);
    const result = await createEventsBeforePurchaseTool(client).handler(period) as {
      events: Array<{ evento: string }>;
    };
    expect(result.events.map((e) => e.evento)).toEqual(['comum', 'raro']);
  });

  it('returns zeros instead of dividing by zero when there were no purchases', async () => {
    const { client } = fakeClient([]);
    const result = await createEventsBeforePurchaseTool(client).handler(period) as {
      totalPurchases: number; events: unknown[];
    };
    expect(result).toMatchObject({ totalPurchases: 0, events: [] });
  });

  it('refuses when the tenant has no BigQuery dataset configured', async () => {
    const { client } = fakeClient([]);
    await expect(createEventsBeforePurchaseTool(client).handler({
      ...period, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4BigQueryDataset não configurado');
  });

  it('exposes no user identifier in the response', async () => {
    const { client } = fakeClient([
      { event_name: 'view_item', users: 950, purchases: 1000, avg_position: 4.7 },
    ]);
    const result = await createEventsBeforePurchaseTool(client).handler(period);
    expect(JSON.stringify(result)).not.toMatch(/user_pseudo_id|pseudo/i);
  });
});
