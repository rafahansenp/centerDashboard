import type { MetricGateway } from '@center/mcp-core';
import type { MetricSeries, TenantContext } from '@center/shared';
import { buildAgentTools, type AgentToolCall } from '../agent/tools.js';

const tenant: TenantContext = {
  organizationId: 'org_1', externalIds: { ga4PropertyId: '111' },
};

const series: MetricSeries = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency', granularity: 'day', total: 480000,
  points: [
    { date: '2026-02-01', value: 100000 },
    { date: '2026-02-15', value: 300000 },
    { date: '2026-02-28', value: 80000 },
  ],
};

function buildGateway(overrides: Record<string, unknown> = {}) {
  return {
    listMetrics: jest.fn(async () => [
      { id: 'commerce.revenue', label: 'Faturamento', description: 'receita', source: 'commerce', unit: 'currency', dimensions: ['campaign'] },
      { id: 'ga4.sessions', label: 'Sessões', description: 'sessões', source: 'ga4', unit: 'count', dimensions: ['device'] },
    ]),
    queryMetric: jest.fn(async () => series),
    queryBatch: jest.fn(async () => [series, series]),
    callTool: jest.fn(async () => ({
      dimension: 'product', from: '2026-02-01', to: '2026-02-28', total: 50000, unit: 'currency',
      rows: Array.from({ length: 10 }, (_, index) => ({
        key: `SKU${index}`, label: `Produto ${index}`, value: 1000 * (10 - index),
        unit: 'currency', extra: { quantity: 1 }, share: 0.1,
      })),
    })),
    ...overrides,
  } as unknown as MetricGateway;
}

const TODAY = '2026-03-15';

function tools(gateway: MetricGateway, onToolCall?: (log: AgentToolCall) => void) {
  return buildAgentTools({ gateway, tenant, today: TODAY, ...(onToolCall ? { onToolCall } : {}) });
}

describe('listar_metricas', () => {
  it('returns the catalog in a compact shape', async () => {
    const result = await tools(buildGateway()).listar_metricas.execute!({}, {} as never);
    expect(result).toEqual({
      metricas: [
        { id: 'commerce.revenue', nome: 'Faturamento', descricao: 'receita', unidade: 'currency', dimensoes: ['campaign'] },
        { id: 'ga4.sessions', nome: 'Sessões', descricao: 'sessões', unidade: 'count', dimensoes: ['device'] },
      ],
    });
  });
});

describe('consultar_metrica', () => {
  it('resolves a Portuguese period phrase into concrete dates', async () => {
    const gateway = buildGateway();
    await tools(gateway).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    );
    expect(gateway.queryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-02-01', to: '2026-02-28', granularity: 'day' }),
    );
  });

  it('accepts explicit from/to instead of a phrase', async () => {
    const gateway = buildGateway();
    await tools(gateway).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-31', granularity: 'month' }, {} as never,
    );
    expect(gateway.queryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-01-01', to: '2026-01-31', granularity: 'month' }),
    );
  });

  it('always injects the tenant from the closure', async () => {
    const gateway = buildGateway();
    await tools(gateway).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'hoje' }, {} as never,
    );
    expect(gateway.queryMetric).toHaveBeenCalledWith(expect.objectContaining({ tenant }));
  });

  it('returns a summary with the total and the peak, not the raw series', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      metricId: 'commerce.revenue', unidade: 'currency', total: 480000,
      periodo: { de: '2026-02-01', ate: '2026-02-28' },
      pico: { data: '2026-02-15', valor: 300000 },
      pontos: 3,
    });
    expect(result).not.toHaveProperty('points');
  });

  it('states plainly that currency values are in cents', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.observacao).toMatch(/centavos/i);
  });

  it('returns an error object instead of throwing on an unresolvable period', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'na época da promoção' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/não entendi o período/i);
  });

  it('returns an error object when neither periodo nor from/to is given', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'commerce.revenue' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/informe/i);
  });

  it('turns a gateway failure into an error object the model can read', async () => {
    const gateway = buildGateway({
      queryMetric: jest.fn(async () => { throw new Error('Uappi respondeu 503'); }),
    });
    const result = await tools(gateway).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'hoje' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toContain('Uappi respondeu 503');
  });

  it('reports every call to the audit callback, including failures', async () => {
    const logs: AgentToolCall[] = [];
    const gateway = buildGateway({ queryMetric: jest.fn(async () => { throw new Error('falhou'); }) });
    await tools(gateway, (log) => logs.push(log)).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'hoje' }, {} as never,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ toolName: 'consultar_metrica', success: false, errorMessage: 'falhou' });
    expect(typeof logs[0]?.durationMs).toBe('number');
  });
});

describe('ranking', () => {
  it('routes a known ranking to the right source and tool', async () => {
    const gateway = buildGateway();
    await tools(gateway).ranking.execute!(
      { tipo: 'produtos_mais_vendidos', periodo: 'mês passado' }, {} as never,
    );
    expect(gateway.callTool).toHaveBeenCalledWith(
      'commerce', 'top_products',
      expect.objectContaining({ from: '2026-02-01', to: '2026-02-28', tenant }),
      expect.anything(),
    );
  });

  it('routes a GA4 ranking to the ga4 source', async () => {
    const gateway = buildGateway();
    await tools(gateway).ranking.execute!(
      { tipo: 'origens_de_trafego', periodo: 'mês passado' }, {} as never,
    );
    expect(gateway.callTool).toHaveBeenCalledWith('ga4', 'traffic_sources', expect.anything(), expect.anything());
  });

  it('trims the ranking to the top five rows for the model', async () => {
    const result = await tools(buildGateway()).ranking.execute!(
      { tipo: 'produtos_mais_vendidos', periodo: 'mês passado' }, {} as never,
    ) as { linhas: unknown[] };
    expect(result.linhas).toHaveLength(5);
  });

  it('rejects an unknown ranking type with the list of valid ones', async () => {
    const result = await tools(buildGateway()).ranking.execute!(
      { tipo: 'produtos_mais_bonitos', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/produtos_mais_vendidos/);
  });
});

describe('correlacionar', () => {
  it('calls the gateway batch once and returns the coefficient', async () => {
    const gateway = buildGateway({
      queryBatch: jest.fn(async () => [
        { ...series, metricId: 'ga4.active_users', unit: 'count', points: [
          { date: '2026-02-01', value: 10 }, { date: '2026-02-15', value: 20 }, { date: '2026-02-28', value: 30 },
        ] },
        { ...series, points: [
          { date: '2026-02-01', value: 100 }, { date: '2026-02-15', value: 200 }, { date: '2026-02-28', value: 300 },
        ] },
      ]),
    });
    const result = await tools(gateway).correlacionar.execute!(
      { metricaA: 'ga4.active_users', metricaB: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.coeficiente).toBeCloseTo(1, 5);
    expect(result.ressalva).toMatch(/causa/i);
  });
});

describe('funil_de_compra', () => {
  it('calls the GA4 funnel tool with the resolved period', async () => {
    const gateway = buildGateway({
      callTool: jest.fn(async () => ({
        from: '2026-02-01', to: '2026-02-28', steps: [], worstStepKey: null,
        overallConversion: 0, identifiesUsers: false, note: 'agregado',
      })),
    });
    await tools(gateway).funil_de_compra.execute!({ periodo: 'mês passado' }, {} as never);
    expect(gateway.callTool).toHaveBeenCalledWith(
      'ga4', 'checkout_funnel',
      expect.objectContaining({ from: '2026-02-01', to: '2026-02-28' }),
      expect.anything(),
    );
  });
});
