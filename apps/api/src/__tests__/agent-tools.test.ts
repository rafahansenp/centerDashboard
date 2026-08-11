import { McpToolError, type MetricGateway } from '@center/mcp-core';
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

  it('turns a gateway failure into a generic error object for the model, never the raw upstream text', async () => {
    // C3: antes, `instrument` devolvia `error.message` cru ao modelo — um
    // texto de upstream (aqui simulado por uma mensagem genérica de rede)
    // chegava ao contexto do LLM, ao invés de uma mensagem genérica.
    const gateway = buildGateway({
      queryMetric: jest.fn(async () => { throw new Error('Uappi respondeu 503'); }),
    });
    const result = await tools(gateway).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'hoje' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).not.toContain('Uappi respondeu 503');
    expect(typeof result.erro).toBe('string');
  });

  it('scrubs an McpToolError (Prisma/host details) before it reaches the model, but still logs the real message for audit', async () => {
    // C3: um McpToolError carrega o texto VERBATIM do servidor MCP — pode
    // nomear tabelas e o host do datasource. Isso nunca pode chegar ao
    // modelo (e daí ao WhatsApp), mas precisa continuar visível no log de
    // auditoria (`ToolCallLog.errorMessage`) para diagnóstico no servidor.
    const upstreamMessage =
      'Prisma: connection to database "center" at host db.internal.corp:5432 failed: ECONNREFUSED';
    const gateway = buildGateway({
      queryMetric: jest.fn(async () => {
        throw new McpToolError('commerce', 'consultar_metrica', upstreamMessage);
      }),
    });
    const logs: AgentToolCall[] = [];
    const result = await tools(gateway, (log) => logs.push(log)).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'hoje' }, {} as never,
    ) as Record<string, unknown>;

    expect(result.erro).not.toMatch(/db\.internal\.corp|Prisma|center/);
    expect(logs[0]?.errorMessage).toContain('db.internal.corp');
  });

  it('still lets an intentional guidance error (unresolved period) reach the model unscrubbed', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'na época da promoção' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/não entendi o período/i);
  });

  it('rejects an explicit from/to range longer than 400 days instead of querying an unbounded window', async () => {
    // C1: `resolveWindow` nunca chamava `assertRange` para from/to explícitos
    // — um LLM (ou um prompt malicioso via WhatsApp) devolvendo um intervalo
    // de séculos chegava direto ao gateway, sem o teto que as rotas HTTP têm.
    const gateway = buildGateway();
    const result = await tools(gateway).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', from: '1900-01-01', to: '2100-01-01' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/400 dias/);
    expect(gateway.queryMetric).not.toHaveBeenCalled();
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

  it('computes a real total from the groups for a ranking whose payload has no top-level total, instead of counting rows', async () => {
    const gateway = buildGateway({
      callTool: jest.fn(async () => ({
        from: '2026-02-01', to: '2026-02-28',
        groups: [
          { group: 'PAID', label: 'Pago', orders: 300, revenueCents: 9000000, share: 300 / 340 },
          { group: 'CANCELLED', label: 'Cancelado', orders: 40, revenueCents: 500000, share: 40 / 340 },
        ],
      })),
    });
    const result = await tools(gateway).ranking.execute!(
      { tipo: 'situacao_dos_pedidos', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    // 340 pedidos no total, não 2 (a quantidade de grupos/linhas).
    expect(result.total).toBe(340);
  });

  it('omits total rather than guessing when the payload has no total and no known way to compute one', async () => {
    const gateway = buildGateway({
      callTool: jest.fn(async () => ({
        from: '2026-02-01', to: '2026-02-28',
        methods: [
          { method: 'pix', paidOrders: 120, failedOrders: 5, conversionRate: 0.96, revenueCents: 3000000, averageTicketCents: 25000 },
        ],
      })),
    });
    const result = await tools(gateway).ranking.execute!(
      { tipo: 'meios_de_pagamento', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty('total');
  });

  it('flags the currency notice when rows carry cents fields even though the ranking\'s primary unit is not currency', async () => {
    const gateway = buildGateway({
      callTool: jest.fn(async () => ({
        dimension: 'campaign', from: '2026-02-01', to: '2026-02-28', total: 0.42, unit: 'ratio',
        rows: [
          { key: 'blackfriday', label: 'blackfriday', value: 0.3, unit: 'ratio',
            extra: { revenueCents: 500000, averageTicketCents: 12000 }, share: 1 },
        ],
      })),
    });
    const result = await tools(gateway).ranking.execute!(
      { tipo: 'campanhas_com_recorrentes', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.observacao).toMatch(/centavos/i);
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

describe('comparar_periodos', () => {
  it('routes a product comparison to commerce.compare_products with both windows', async () => {
    const gateway = buildGateway({
      callTool: jest.fn(async () => ({ rows: [{ key: 'SKU1', deltaCents: -5000 }], unit: 'currency' })),
    });
    const result = await tools(gateway).comparar_periodos.execute!(
      { tipo: 'produtos', periodoAnterior: 'mês passado', periodoAtual: 'este mês' }, {} as never,
    ) as Record<string, unknown>;
    expect(gateway.callTool).toHaveBeenCalledWith(
      'commerce', 'compare_products',
      expect.objectContaining({
        periodA: { from: '2026-02-01', to: '2026-02-28' },
        periodB: { from: '2026-03-01', to: '2026-03-15' },
      }),
      expect.anything(),
    );
    expect(result.observacao).toMatch(/centavos/i);
  });

  it('routes an event comparison to ga4.compare_events', async () => {
    const gateway = buildGateway({
      callTool: jest.fn(async () => ({ rows: [] })),
    });
    await tools(gateway).comparar_periodos.execute!(
      { tipo: 'eventos', periodoAnterior: 'mês passado', periodoAtual: 'este mês' }, {} as never,
    );
    expect(gateway.callTool).toHaveBeenCalledWith('ga4', 'compare_events', expect.anything(), expect.anything());
  });

  it('rejects a period longer than 400 days instead of sending an unbounded periodA to compare_products', async () => {
    // C1: `compare_products`/`compare_events` recebem `periodA`/`periodB`
    // (não `from`/`to` no nível raiz) — o teto de 400 dias precisa ser
    // checado explicitamente aqui, não só em `resolveWindow`.
    const gateway = buildGateway();
    const result = await tools(gateway).comparar_periodos.execute!(
      { tipo: 'produtos', periodoAnterior: 'últimos 500 dias', periodoAtual: 'este mês' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/400 dias/);
    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it('returns an error object instead of throwing when a period phrase is not understood', async () => {
    const result = await tools(buildGateway()).comparar_periodos.execute!(
      { tipo: 'produtos', periodoAnterior: 'na época da promoção', periodoAtual: 'este mês' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/não entendi/i);
  });
});

describe('impacto_da_versao', () => {
  it('compares symmetric windows before and after the release date', async () => {
    const gateway = buildGateway({
      queryBatch: jest.fn(async () => [
        { ...series, metricId: 'commerce.revenue', total: 100_000 },
        { ...series, metricId: 'commerce.orders', unit: 'count', total: 50 },
        { ...series, metricId: 'ga4.active_users', unit: 'count', total: 200 },
      ]),
    });
    const result = await tools(gateway).impacto_da_versao.execute!(
      { versao: '5.8.0', dataDeLancamento: '2026-02-01' }, {} as never,
    ) as Record<string, unknown>;
    expect(result).toMatchObject({ versao: '5.8.0', lancamento: '2026-02-01' });
    expect(result.observacao).toMatch(/centavos/i);
  });

  it('returns an error object instead of throwing on a release date in the future', async () => {
    const result = await tools(buildGateway()).impacto_da_versao.execute!(
      { versao: '5.8.0', dataDeLancamento: '2026-12-31' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/futuro/i);
  });
});
