import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { MetricDescriptor, MetricQuery, MetricSeries, MetricSource } from '@center/shared';
import { createMetricServer, type AnalysisTool, type MetricProvider } from '../server.js';
import { McpPool, McpToolError, sourceOf } from '../pool.js';

function providerFor(source: MetricSource, name: string, total: number): MetricProvider {
  const descriptor: MetricDescriptor = {
    id: `${source}.${name}`, label: name, description: `${name} de ${source}`,
    source, unit: 'count', dimensions: [],
  };
  return {
    descriptors: [descriptor],
    async query(q: MetricQuery): Promise<MetricSeries> {
      return {
        metricId: q.metricId, source, unit: 'count', granularity: q.granularity,
        total, points: [{ date: q.from, value: total }],
      };
    },
  };
}

const echoTool: AnalysisTool = {
  name: 'top_products',
  description: 'echo',
  inputSchema: { limit: z.number() },
  outputSchema: { rows: z.array(z.object({ key: z.string() })) },
  handler: async (args) => ({ rows: [{ key: `limit=${(args as { limit: number }).limit}` }] }),
};

async function linkedClient(provider: MetricProvider, tools: AnalysisTool[] = []): Promise<Client> {
  const server = createMetricServer({ name: 'srv', version: '1.0.0', provider, tools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pool-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const query: MetricQuery = {
  metricId: 'ga4.sessions', from: '2026-01-01', to: '2026-01-01',
  granularity: 'day', tenant: { organizationId: 'org_1', externalIds: {} },
};

describe('sourceOf', () => {
  it('extracts the source from the metric id prefix', () => {
    expect(sourceOf('commerce.revenue')).toBe('commerce');
    expect(sourceOf('ga4.sessions')).toBe('ga4');
  });

  it('throws when there is no dot separator', () => {
    expect(() => sourceOf('revenue')).toThrow('metricId inválido');
  });

  it('throws when the prefix is not a known source', () => {
    expect(() => sourceOf('mixpanel.events')).toThrow('metricId inválido');
  });
});

describe('McpPool', () => {
  let pool: McpPool;

  beforeEach(async () => {
    pool = McpPool.fromConnections([
      { source: 'ga4', client: await linkedClient(providerFor('ga4', 'sessions', 100)) },
      { source: 'commerce', client: await linkedClient(providerFor('commerce', 'revenue', 250), [echoTool]) },
    ]);
  });

  afterEach(async () => { await pool.close(); });

  it('merges the catalogs of every connected server', async () => {
    const metrics = await pool.listMetrics();
    expect(metrics.map((m) => m.id).sort()).toEqual(['commerce.revenue', 'ga4.sessions']);
  });

  it('routes a query to the server named by the metric id prefix', async () => {
    expect((await pool.queryMetric(query)).total).toBe(100);
    expect((await pool.queryMetric({ ...query, metricId: 'commerce.revenue' })).total).toBe(250);
  });

  it('throws when no server serves the metric source', async () => {
    await expect(pool.queryMetric({ ...query, metricId: 'behavior.paths' }))
      .rejects.toThrow('nenhum servidor MCP conectado para a fonte "behavior"');
  });

  it('converts an MCP tool error into McpToolError', async () => {
    await expect(pool.queryMetric({ ...query, metricId: 'ga4.inexistente' }))
      .rejects.toBeInstanceOf(McpToolError);
  });

  it('calls a named analysis tool on the right server', async () => {
    const result = await pool.callTool<{ rows: Array<{ key: string }> }>(
      'commerce', 'top_products', { limit: 5 },
    );
    expect(result.rows[0]?.key).toBe('limit=5');
  });

  it('keeps serving the other sources when one server is absent', async () => {
    const single = McpPool.fromConnections([
      { source: 'ga4', client: await linkedClient(providerFor('ga4', 'sessions', 100)) },
    ]);
    expect((await single.listMetrics()).map((m) => m.id)).toEqual(['ga4.sessions']);
    await single.close();
  });

  it('throws when a tool reports success but omits structuredContent', async () => {
    const stubClient = { callTool: jest.fn(async () => ({})) } as unknown as Client;
    const bare = McpPool.fromConnections([{ source: 'ga4', client: stubClient }]);
    await expect(bare.queryMetric(query)).rejects.toThrow('resposta sem structuredContent');
  });
});
