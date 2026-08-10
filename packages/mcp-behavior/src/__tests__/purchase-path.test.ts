import { assertDatasetName } from '../client.js';
import {
  buildPurchasePathSql,
  buildTotalBuyersSql,
  createEventsBeforePurchaseTool,
} from '../purchase-path.js';
import type { BigQueryEventsClientLike } from '../interface.js';

/**
 * O client falso agora precisa distinguir as duas queries que o handler
 * dispara (total de compradores e caminho de eventos) — elas são
 * intencionalmente independentes uma da outra (ver comentário em
 * `buildTotalBuyersSql`), então o mock decide qual conjunto de linhas
 * devolver olhando para o texto da SQL recebida, em vez de depender da ordem
 * das chamadas.
 */
function fakeClient(rows: { buyers?: unknown[]; events?: unknown[] } = {}) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('AS buyers')) return rows.buyers ?? [];
    return rows.events ?? [];
  });
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

describe('buildTotalBuyersSql', () => {
  it('reads from the events_* wildcard table of the dataset', () => {
    const sql = buildTotalBuyersSql({ dataset: 'analytics_123456' });
    expect(sql).toContain('`analytics_123456.events_*`');
  });

  it('uses named parameters instead of interpolating dates', () => {
    const sql = buildTotalBuyersSql({ dataset: 'analytics_123456' });
    expect(sql).toContain('@fromCompact');
    expect(sql).toContain('@toCompact');
    expect(sql).not.toMatch(/\d{8}/);
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
    expect(createEventsBeforePurchaseTool(fakeClient().client).name).toBe('events_before_purchase');
  });

  it('converts the ISO dates into the GA4 compact suffix format for both queries', async () => {
    const { client, query } = fakeClient({ buyers: [{ buyers: 0 }], events: [] });
    await createEventsBeforePurchaseTool(client).handler(period);
    expect(query.mock.calls[0]![1]).toMatchObject({ fromCompact: '20260201', toCompact: '20260228' });
    expect(query.mock.calls[1]![1]).toMatchObject({ fromCompact: '20260201', toCompact: '20260228' });
  });

  it('maps rows into events ordered by how often they precede a purchase', async () => {
    const { client } = fakeClient({
      buyers: [{ buyers: 1000 }],
      events: [
        { event_name: 'add_to_cart', users: 800, avg_position: 2.1 },
        { event_name: 'view_item', users: 950, avg_position: 4.7 },
      ],
    });
    const result = await createEventsBeforePurchaseTool(client).handler(period) as {
      totalBuyers: number; events: Array<Record<string, number | string>>;
    };
    expect(result.totalBuyers).toBe(1000);
    expect(result.events[0]).toMatchObject({ evento: 'view_item', usuarios: 950 });
    expect(result.events[0]?.frequencia).toBeCloseTo(0.95, 5);
  });

  it('sorts by frequency descending', async () => {
    const { client } = fakeClient({
      buyers: [{ buyers: 1000 }],
      events: [
        { event_name: 'raro', users: 10, avg_position: 1 },
        { event_name: 'comum', users: 900, avg_position: 3 },
      ],
    });
    const result = await createEventsBeforePurchaseTool(client).handler(period) as {
      events: Array<{ evento: string }>;
    };
    expect(result.events.map((e) => e.evento)).toEqual(['comum', 'raro']);
  });

  it('returns zeros instead of dividing by zero when there were no buyers', async () => {
    const { client } = fakeClient({ buyers: [{ buyers: 0 }], events: [] });
    const result = await createEventsBeforePurchaseTool(client).handler(period) as {
      totalBuyers: number; events: unknown[];
    };
    expect(result).toMatchObject({ totalBuyers: 0, events: [] });
  });

  it('reports the real buyer total even when the events query comes back empty', async () => {
    // Regressão: compradores existem no período, mas nenhum deles tem evento
    // precedente dentro da janela de lookback (ex.: a compra é o próprio
    // evento mais antigo capturado). Antes da correção, o total de
    // compradores vinha de uma subquery escalar acoplada à query de eventos
    // precedentes — como essa query não devolvia nenhuma linha nesse cenário,
    // o total zerava silenciosamente mesmo havendo compradores de verdade.
    // Agora as duas queries são independentes, então o total permanece
    // correto mesmo com `events` vazio.
    const { client } = fakeClient({ buyers: [{ buyers: 1000 }], events: [] });
    const result = await createEventsBeforePurchaseTool(client).handler(period) as {
      totalBuyers: number; events: unknown[];
    };
    expect(result).toMatchObject({ totalBuyers: 1000, events: [] });
  });

  it('refuses when the tenant has no BigQuery dataset configured', async () => {
    const { client } = fakeClient();
    await expect(createEventsBeforePurchaseTool(client).handler({
      ...period, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4BigQueryDataset não configurado');
  });

  it('exposes no user identifier in the response', async () => {
    const { client } = fakeClient({
      buyers: [{ buyers: 1000 }],
      events: [{ event_name: 'view_item', users: 950, avg_position: 4.7 }],
    });
    const result = await createEventsBeforePurchaseTool(client).handler(period);
    expect(JSON.stringify(result)).not.toMatch(/user_pseudo_id|pseudo/i);
  });
});
