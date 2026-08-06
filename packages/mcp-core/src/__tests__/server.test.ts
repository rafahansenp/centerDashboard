import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { MetricDescriptor, MetricQuery, MetricSeries } from '@center/shared';
import { createMetricServer, MetricNotFoundError, type AnalysisTool, type MetricProvider } from '../server.js';

const descriptors: MetricDescriptor[] = [{
  id: 'commerce.revenue', label: 'Faturamento',
  description: 'Receita de pedidos pagos, em centavos',
  source: 'commerce', unit: 'currency', dimensions: ['channel'],
}];

function buildProvider(overrides: Partial<MetricProvider> = {}): MetricProvider {
  return {
    descriptors,
    async query(q: MetricQuery): Promise<MetricSeries> {
      if (q.metricId !== 'commerce.revenue') throw new MetricNotFoundError(q.metricId);
      return {
        metricId: q.metricId, source: 'commerce', unit: 'currency',
        granularity: q.granularity, total: 30000,
        points: [{ date: '2026-01-01', value: 10000 }, { date: '2026-01-02', value: 20000 }],
      };
    },
    ...overrides,
  };
}

const topProductsTool: AnalysisTool = {
  name: 'top_products',
  description: 'Produtos mais vendidos no período',
  inputSchema: { from: z.string(), to: z.string(), limit: z.number().optional() },
  outputSchema: { rows: z.array(z.object({ key: z.string(), value: z.number() })) },
  handler: async () => ({ rows: [{ key: 'CAM-001', value: 16000 }] }),
};

async function connect(options: Parameters<typeof createMetricServer>[0]) {
  const server = createMetricServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const validQuery = {
  metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-02',
  granularity: 'day' as const,
  tenant: { organizationId: 'org_1', externalIds: {} },
};

describe('createMetricServer — família de métricas', () => {
  it('exposes list_metrics and query_metric when a provider is given', async () => {
    const { client, close } = await connect({ name: 's', version: '1.0.0', provider: buildProvider() });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_metrics', 'query_metric']);
    await close();
  });

  it('returns the catalog through list_metrics', async () => {
    const { client, close } = await connect({ name: 's', version: '1.0.0', provider: buildProvider() });
    const result = await client.callTool({ name: 'list_metrics', arguments: {} });
    expect(result.structuredContent).toEqual({ metrics: descriptors });
    await close();
  });

  it('returns a metric series through query_metric', async () => {
    const { client, close } = await connect({ name: 's', version: '1.0.0', provider: buildProvider() });
    const result = await client.callTool({ name: 'query_metric', arguments: validQuery });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ metricId: 'commerce.revenue', total: 30000 });
    await close();
  });

  it('reports an unknown metric as a tool error, not a crash', async () => {
    const { client, close } = await connect({ name: 's', version: '1.0.0', provider: buildProvider() });
    const result = await client.callTool({
      name: 'query_metric', arguments: { ...validQuery, metricId: 'commerce.inexistente' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('commerce.inexistente');
    await close();
  });

  it('surfaces a provider failure as a tool error', async () => {
    const provider = buildProvider({ query: async () => { throw new Error('postgres indisponível'); } });
    const { client, close } = await connect({ name: 's', version: '1.0.0', provider });
    const result = await client.callTool({ name: 'query_metric', arguments: validQuery });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('postgres indisponível');
    await close();
  });

  it('rejects a query missing the tenant before reaching the provider', async () => {
    const query = jest.fn();
    const { client, close } = await connect({
      name: 's', version: '1.0.0', provider: buildProvider({ query }),
    });
    const { tenant: _omitted, ...withoutTenant } = validQuery;
    const result = await client.callTool({ name: 'query_metric', arguments: withoutTenant });
    expect(result.isError).toBe(true);
    expect(query).not.toHaveBeenCalled();
    await close();
  });
});

describe('createMetricServer — família de análise', () => {
  it('registers named analysis tools alongside the metric tools', async () => {
    const { client, close } = await connect({
      name: 's', version: '1.0.0', provider: buildProvider(), tools: [topProductsTool],
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_metrics', 'query_metric', 'top_products']);
    await close();
  });

  it('runs an analysis tool and returns its structured payload', async () => {
    const { client, close } = await connect({
      name: 's', version: '1.0.0', provider: buildProvider(), tools: [topProductsTool],
    });
    const result = await client.callTool({
      name: 'top_products', arguments: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(result.structuredContent).toEqual({ rows: [{ key: 'CAM-001', value: 16000 }] });
    await close();
  });

  it('turns an analysis tool failure into a tool error', async () => {
    const failing: AnalysisTool = {
      ...topProductsTool,
      handler: async () => { throw new Error('consulta demorou demais'); },
    };
    const { client, close } = await connect({ name: 's', version: '1.0.0', tools: [failing] });
    const result = await client.callTool({
      name: 'top_products', arguments: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('consulta demorou demais');
    await close();
  });

  it('serves a tools-only server with no provider', async () => {
    const { client, close } = await connect({ name: 's', version: '1.0.0', tools: [topProductsTool] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['top_products']);
    await close();
  });
});
