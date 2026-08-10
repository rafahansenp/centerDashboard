import type { MetricGateway } from '@center/mcp-core';
import type { MetricSeries, TenantContext } from '@center/shared';
import { buildAgentTools } from '../agent/tools.js';
import { buildSystemPrompt } from '../agent/agent.js';

const CENTS = 480000;
const tenant: TenantContext = { organizationId: 'org_1', externalIds: {} };

const revenueSeries: MetricSeries = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency', granularity: 'day',
  total: CENTS, points: [{ date: '2026-02-01', value: CENTS }],
};

function buildGateway() {
  return {
    listMetrics: jest.fn(async () => []),
    queryMetric: jest.fn(async () => revenueSeries),
    queryBatch: jest.fn(async () => [revenueSeries]),
    callTool: jest.fn(async () => ({ rows: [], unit: 'currency', total: CENTS })),
  } as unknown as MetricGateway;
}

describe('contrato de centavos — system prompt', () => {
  const prompt = buildSystemPrompt('2026-03-15');

  it('states the unit in capitals so the instruction is hard to skim past', () => {
    expect(prompt).toContain('CENTAVOS');
  });

  it('gives a worked numeric example, not just the rule', () => {
    // A regra sozinha é ignorada com frequência; o exemplo é o que gruda.
    expect(prompt).toMatch(/480000/);
    expect(prompt).toMatch(/4\.800,00/);
  });
});

describe('contrato de centavos — ferramentas do agente', () => {
  const tools = buildAgentTools({ gateway: buildGateway(), tenant, today: '2026-03-15' });

  it('passes the metric total through untouched, still in cents', async () => {
    const result = await tools.consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.total).toBe(CENTS);
  });

  it('attaches an explicit cents warning to every currency result', async () => {
    const result = await tools.consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    ) as Record<string, string>;
    expect(result.observacao).toMatch(/CENTAVOS/);
  });

  it('does not attach the cents warning to a count result', async () => {
    const gateway = buildGateway();
    (gateway.queryMetric as jest.Mock).mockResolvedValueOnce({
      ...revenueSeries, metricId: 'commerce.orders', unit: 'count', total: 42,
      points: [{ date: '2026-02-01', value: 42 }],
    });
    const countTools = buildAgentTools({ gateway, tenant, today: '2026-03-15' });
    const result = await countTools.consultar_metrica.execute!(
      { metricId: 'commerce.orders', periodo: 'mês passado' }, {} as never,
    ) as Record<string, string>;
    expect(result.observacao).not.toMatch(/CENTAVOS/);
  });

  it('warns about cents in a currency ranking too', async () => {
    const result = await tools.ranking.execute!(
      { tipo: 'campanhas_por_receita', periodo: 'mês passado' }, {} as never,
    ) as Record<string, string>;
    expect(result.observacao).toMatch(/CENTAVOS/);
  });
});
