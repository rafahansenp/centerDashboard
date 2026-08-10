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

  // Review finding #2: LOGICAL_OR returns NULL (not FALSE) when `screen` is
  // NULL for every event of a user — e.g. a property that never populates
  // firebase_screen/screen_name/page_title. Without COALESCE, GROUP BY
  // saw_screen produces a third `NULL` bucket that silently drops those
  // users from both cohorts.
  it('coalesces saw_screen to a boolean so users without any screen data are not dropped into a third group', () => {
    const sql = buildScreenImpactSql({ dataset: 'analytics_123456' });
    expect(sql).toContain('COALESCE(LOGICAL_OR(screen = @screenName), FALSE) AS saw_screen');
  });

  // Review finding #3: a plain correlated scalar subquery throws "Scalar
  // subquery produced more than one element" in real BigQuery if a single
  // event happens to carry more than one of the three matching keys at once.
  // ANY_VALUE guarantees the subquery stays scalar regardless of how many
  // UNNEST rows match. This is BigQuery engine behavior — it can't be
  // exercised against the fake client (see `screen_abandon_impact` describe
  // block below), so this test only locks in the defensive SQL shape.
  it('extracts the screen name defensively so more than one matching event_param key cannot crash the query', () => {
    const sql = buildScreenImpactSql({ dataset: 'analytics_123456' });
    expect(sql).toContain('ANY_VALUE(value.string_value)');
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

  // Review finding #1: a screen name that matches zero users (typo, case
  // mismatch against what GA4/Firebase logs, or a screen that simply isn't
  // instrumented) must not produce a fabricated `diferenca` — e.g. "-0.20"
  // read by the agent as "quem vê essa tela compra 20 pontos menos", when
  // the real story is "não achei ninguém nessa tela".
  it('returns diferenca: null and an explanatory note when nobody matched the screen name', async () => {
    const { client } = fakeClient([{ saw_screen: false, users: 200, buyers: 40 }]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as {
      diferenca: number | null; observacao: string; viramATela: { usuarios: number };
    };
    expect(result.diferenca).toBeNull();
    expect(result.viramATela.usuarios).toBe(0);
    expect(result.observacao).toMatch(/checkout/i);
    expect(result.observacao.length).toBeGreaterThan(0);
  });

  // Symmetric case: everyone in the period matched the screen, so there is
  // no comparison group either — same "no data" guard, opposite side.
  it('returns diferenca: null and an explanatory note when everyone matched the screen name', async () => {
    const { client } = fakeClient([{ saw_screen: true, users: 150, buyers: 30 }]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as {
      diferenca: number | null; observacao: string; naoViramATela: { usuarios: number };
    };
    expect(result.diferenca).toBeNull();
    expect(result.naoViramATela.usuarios).toBe(0);
    expect(result.observacao.length).toBeGreaterThan(0);
  });

  it('leaves observacao empty and diferenca numeric when both cohorts have users', async () => {
    const { client } = fakeClient([
      { saw_screen: true, users: 1000, buyers: 50 },
      { saw_screen: false, users: 500, buyers: 100 },
    ]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as {
      diferenca: number | null; observacao: string;
    };
    expect(result.observacao).toBe('');
    expect(result.diferenca).toBeCloseTo(-0.15, 5);
  });
});
