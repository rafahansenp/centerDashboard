import { buildScreenImpactSql, createScreenAbandonImpactTool } from '../screen-impact.js';
import type { BigQueryEventsClientLike } from '../interface.js';

function fakeClient(rows: unknown[]) {
  const query = jest.fn(async () => rows);
  return { client: { query } as unknown as BigQueryEventsClientLike, query };
}

const tenant = {
  organizationId: 'org_1', externalIds: { ga4BigQueryDataset: 'analytics_123456' },
};

const input = { from: '2026-02-01', to: '2026-02-28', tenant, tela: 'Checkout' };

describe('buildScreenImpactSql', () => {
  it('reads from the events_* wildcard table of the dataset', () => {
    expect(buildScreenImpactSql({ dataset: 'analytics_123456' }))
      .toContain('`analytics_123456.events_*`');
  });

  it('filters the partition to keep the scan cheap', () => {
    expect(buildScreenImpactSql({ dataset: 'analytics_123456' }))
      .toContain('_TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact');
  });

  it('passes the screen name as a named parameter, never interpolated', () => {
    const sql = buildScreenImpactSql({ dataset: 'analytics_123456' });
    expect(sql).toContain('@screenName');
    expect(sql).not.toContain('Checkout');
  });

  it('rejects a dataset with a backtick', () => {
    expect(() => buildScreenImpactSql({ dataset: 'x`; DROP TABLE y; --' })).toThrow('dataset inválido');
  });
});

describe('screen_abandon_impact', () => {
  it('sends the screen name and compact dates as parameters', async () => {
    const { client, query } = fakeClient([{ saw_screen: true, users: 100, buyers: 5 }]);
    await createScreenAbandonImpactTool(client).handler(input);
    expect(query.mock.calls[0]![1]).toMatchObject({
      screenName: 'Checkout', fromCompact: '20260201', toCompact: '20260228',
    });
  });

  it('computes the purchase rate for each cohort', async () => {
    const { client } = fakeClient([
      { saw_screen: true, users: 1000, buyers: 50 },
      { saw_screen: false, users: 500, buyers: 100 },
    ]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as Record<string, unknown>;
    expect(result).toMatchObject({
      tela: 'Checkout',
      viramATela: { usuarios: 1000, compradores: 50 },
      naoViramATela: { usuarios: 500, compradores: 100 },
    });
    expect((result.viramATela as { taxaDeCompra: number }).taxaDeCompra).toBeCloseTo(0.05, 5);
    expect((result.naoViramATela as { taxaDeCompra: number }).taxaDeCompra).toBeCloseTo(0.2, 5);
  });

  it('reports the difference in percentage points', async () => {
    const { client } = fakeClient([
      { saw_screen: true, users: 1000, buyers: 50 },
      { saw_screen: false, users: 500, buyers: 100 },
    ]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as { diferenca: number };
    expect(result.diferenca).toBeCloseTo(-0.15, 5);
  });

  it('does not divide by zero for an empty cohort', async () => {
    const { client } = fakeClient([{ saw_screen: true, users: 0, buyers: 0 }]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as Record<string, unknown>;
    expect((result.viramATela as { taxaDeCompra: number }).taxaDeCompra).toBe(0);
    expect((result.naoViramATela as { taxaDeCompra: number }).taxaDeCompra).toBe(0);
  });

  it('always carries the causality caveat', async () => {
    const { client } = fakeClient([{ saw_screen: true, users: 10, buyers: 1 }]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as { ressalva: string };
    expect(result.ressalva).toMatch(/não (implica|prova) causa/i);
  });

  it('refuses when the tenant has no BigQuery dataset configured', async () => {
    const { client } = fakeClient([]);
    await expect(createScreenAbandonImpactTool(client).handler({
      ...input, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4BigQueryDataset não configurado');
  });

  it('exposes no user identifier in the response', async () => {
    const { client } = fakeClient([{ saw_screen: true, users: 10, buyers: 1 }]);
    const result = await createScreenAbandonImpactTool(client).handler(input);
    expect(JSON.stringify(result)).not.toMatch(/user_pseudo_id|pseudo/i);
  });
});
