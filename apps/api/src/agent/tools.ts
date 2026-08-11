import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { correlateMetrics, type MetricGateway } from '@center/mcp-core';
import { GranularitySchema, type MetricQuery, type MetricSource, type TenantContext } from '@center/shared';
import { resolvePeriodPhrase } from './date-resolver.js';
import { analyzeAppVersionImpact } from '../analysis/app-version-impact.js';
import { assertRange, BadRequestError } from '../range.js';
import { AgentGuidanceError } from '../errors.js';

export interface AgentToolCall {
  toolName: string;
  input: unknown;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
}

export interface AgentToolContext {
  gateway: MetricGateway;
  tenant: TenantContext;
  today: string;
  onToolCall?: (log: AgentToolCall) => void;
}

/** Quantas linhas de ranking vão para o contexto do modelo. */
const RANKING_ROWS_FOR_MODEL = 5;

/** Mensagem padrão para qualquer resposta que carregue valor monetário cru. */
const CENTS_NOTICE = 'Valores em CENTAVOS — divida por 100 para reais.';

/**
 * Catálogo de rankings, com o nome que o usuário usaria.
 *
 * Uma ferramenta só, com o tipo como parâmetro, em vez de doze ferramentas
 * quase idênticas — doze opções parecidas degradam a escolha do modelo.
 */
const RANKINGS: Record<string, { source: MetricSource; tool: string; descricao: string }> = {
  produtos_mais_vendidos: { source: 'commerce', tool: 'top_products', descricao: 'produtos por faturamento' },
  categorias_mais_vendidas: { source: 'commerce', tool: 'top_categories', descricao: 'categorias por faturamento' },
  campanhas_por_receita: { source: 'commerce', tool: 'campaign_revenue', descricao: 'campanhas por receita real' },
  ticket_por_canal: { source: 'commerce', tool: 'channel_average_ticket', descricao: 'ticket médio por canal' },
  receita_por_dispositivo: { source: 'commerce', tool: 'device_revenue', descricao: 'receita por dispositivo' },
  campanhas_com_recorrentes: { source: 'commerce', tool: 'campaign_returning_customers', descricao: 'taxa de recompra por campanha' },
  situacao_dos_pedidos: { source: 'commerce', tool: 'orders_by_status', descricao: 'pedidos por situação' },
  pedidos_que_falharam: { source: 'commerce', tool: 'failed_orders', descricao: 'compras com pagamento recusado' },
  meios_de_pagamento: { source: 'commerce', tool: 'payment_method_performance', descricao: 'conversão por meio de pagamento' },
  // 'produtos_sem_estoque' (out_of_stock_products) removida deliberadamente:
  // a ferramenta nunca foi implementada (spike de catálogo/estoque bloqueado
  // por falta de credencial da Uappi). Restaurar quando o spike for
  // desbloqueado — até lá, listá-la aqui só produz um McpToolError.
  origens_de_trafego: { source: 'ga4', tool: 'traffic_sources', descricao: 'origens por usuários' },
  campanhas_por_usuarios: { source: 'ga4', tool: 'campaign_users', descricao: 'campanhas por usuários' },
  paginas_com_abandono: { source: 'ga4', tool: 'page_performance', descricao: 'páginas por taxa de rejeição' },
  conversao_por_dispositivo: { source: 'ga4', tool: 'device_performance', descricao: 'conversão por dispositivo' },
  versoes_do_app: { source: 'ga4', tool: 'app_versions', descricao: 'usuários por versão do app' },
  eventos_mais_frequentes: { source: 'ga4', tool: 'top_events', descricao: 'eventos por contagem' },
};

const RANKING_NAMES = Object.keys(RANKINGS);

/**
 * Nem toda ferramenta de ranking devolve um total agregado do período —
 * `orders_by_status` e `payment_method_performance` só trazem os grupos.
 * `rows.length` (quantidade de linhas exibidas) NÃO é o total: para
 * `situacao_dos_pedidos`, por exemplo, seria a quantidade de status
 * distintos (ex.: 4), não a quantidade de pedidos (ex.: 340).
 *
 * Quando existe uma soma correta calculável a partir dos dados, calculamos;
 * quando não existe uma definição inequívoca (ex.: "total" de
 * payment_method_performance seria pedidos pagos? tentativas? por método?),
 * omitimos o campo — um número plausível mas errado é pior que a ausência.
 */
function computeRankingTotal(
  toolName: string, payload: Record<string, unknown>, rows: unknown[],
): number | undefined {
  if (typeof payload.total === 'number') return payload.total;

  if (toolName === 'orders_by_status') {
    return rows.reduce((acc: number, row) => {
      const orders = (row as { orders?: unknown }).orders;
      return acc + (typeof orders === 'number' ? orders : 0);
    }, 0);
  }

  return undefined;
}

/**
 * Detecta campo monetário em qualquer profundidade (inclusive dentro de
 * `extra`). Alguns rankings não são de moeda no valor principal (ex.:
 * `campanhas_com_recorrentes` é uma taxa, `situacao_dos_pedidos` é uma
 * contagem), mas as linhas carregam campos auxiliares em centavos
 * (`revenueCents`, `totalCents`, `averageTicketCents`) — o modelo precisa do
 * aviso sempre que esses campos aparecerem, não só quando a métrica
 * ordenada é dinheiro.
 */
function hasCentsField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCentsField);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nested]) => /Cents$/.test(key) || hasCentsField(nested),
    );
  }
  return false;
}

/**
 * Mensagem genérica devolvida ao modelo para qualquer falha que não seja
 * nossa própria orientação (`AgentGuidanceError`/`BadRequestError`) — ou
 * seja, qualquer erro vindo de um sistema upstream (`McpToolError` do MCP
 * server, Prisma, rede). Mesma política de `upstreamError` em
 * `routes/metrics.ts`: mensagem genérica para fora, mensagem real só no log
 * de auditoria (`errorMessage` abaixo, que vira `ToolCallLog.errorMessage`).
 */
const GENERIC_TOOL_ERROR = 'não consegui obter esse dado agora. tente de novo em instantes.';

/**
 * Erros com mensagem segura para repassar ao modelo: nós mesmos as
 * escrevemos para serem lidas por ele (período não entendido, ranking
 * desconhecido, data no futuro) ou para orientar quem chama a ferramenta
 * (intervalo inválido/grande demais). Qualquer outro erro carrega texto de
 * um sistema upstream, que pode incluir nomes de tabela, host do banco ou
 * stack trace — isso NUNCA deve chegar ao modelo (e daí ao WhatsApp).
 */
function isSafeToShareWithModel(error: unknown): boolean {
  return error instanceof AgentGuidanceError || error instanceof BadRequestError;
}

/**
 * Envolve o corpo de uma ferramenta com cronômetro, auditoria e conversão de
 * exceção em objeto de erro. O modelo NUNCA deve receber um throw: ele precisa
 * ler a mensagem e decidir se tenta outra coisa ou explica ao usuário.
 */
function instrument<TInput, TOutput extends Record<string, unknown>>(
  context: AgentToolContext,
  toolName: string,
  body: (input: TInput) => Promise<TOutput>,
) {
  return async (input: TInput): Promise<TOutput | { erro: string }> => {
    const startedAt = Date.now();
    try {
      const output = await body(input);
      context.onToolCall?.({ toolName, input, durationMs: Date.now() - startedAt, success: true });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A mensagem REAL sempre vai para a auditoria (ToolCallLog), mesmo
      // quando é genérica para o modelo — é assim que a falha continua
      // diagnosticável no servidor.
      context.onToolCall?.({
        toolName, input, durationMs: Date.now() - startedAt, success: false, errorMessage: message,
      });
      return { erro: isSafeToShareWithModel(error) ? message : GENERIC_TOOL_ERROR };
    }
  };
}

interface PeriodInput {
  periodo?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  granularity?: 'day' | 'week' | 'month' | undefined;
}

function resolveWindow(input: PeriodInput, today: string): {
  from: string; to: string; granularity: 'day' | 'week' | 'month';
} {
  if (input.periodo) {
    const resolved = resolvePeriodPhrase(input.periodo, today);
    if (!resolved) {
      throw new AgentGuidanceError(
        `não entendi o período "${input.periodo}". Peça ao usuário as datas exatas ou use uma ` +
        `expressão como "mês passado", "últimos 30 dias" ou "fevereiro de 2026".`,
      );
    }
    // `resolvePeriodPhrase` só produz janelas de tamanho fixo (dias/semanas/
    // meses de um vocabulário conhecido) — nunca deveria estourar o teto,
    // mas validamos mesmo assim: mesma trava usada nas rotas HTTP, para que
    // as duas fronteiras (chat e API) nunca divirjam.
    assertRange(resolved);
    return { from: resolved.from, to: resolved.to, granularity: input.granularity ?? resolved.granularity };
  }

  if (!input.from || !input.to) {
    throw new AgentGuidanceError('informe "periodo" ou o par "from"/"to" em YYYY-MM-DD');
  }
  // `from`/`to` explícitos chegam aqui como texto livre do modelo — sem este
  // teto, um LLM confuso (ou um prompt malicioso via WhatsApp) que devolvesse
  // "from":"1900-01-01","to":"2100-01-01" varreria a tabela inteira no
  // Postgres, sem a proteção de `maximumBytesBilled` que o BigQuery tem.
  assertRange({ from: input.from, to: input.to });
  return { from: input.from, to: input.to, granularity: input.granularity ?? 'day' };
}

const PeriodShape = {
  periodo: z.string().optional().describe('expressão de período em português, ex.: "mês passado"'),
  from: z.string().optional().describe('data inicial YYYY-MM-DD'),
  to: z.string().optional().describe('data final YYYY-MM-DD'),
};

export function buildAgentTools(context: AgentToolContext): ToolSet {
  const { gateway, tenant, today } = context;

  return {
    listar_metricas: tool({
      description:
        'Lista as métricas disponíveis com id, unidade e dimensões filtráveis. Chame SEMPRE ' +
        'antes de consultar_metrica quando não tiver certeza do id exato.',
      inputSchema: z.object({}),
      execute: instrument(context, 'listar_metricas', async () => ({
        metricas: (await gateway.listMetrics()).map((metric) => ({
          id: metric.id, nome: metric.label, descricao: metric.description,
          unidade: metric.unit, dimensoes: metric.dimensions,
        })),
      })),
    }),

    consultar_metrica: tool({
      description:
        'Valor de uma métrica em um período. Informe "periodo" com uma expressão em português ' +
        '(ex.: "hoje", "mês passado", "últimos 30 dias", "fevereiro de 2026") OU "from" e "to" ' +
        'em YYYY-MM-DD. Retorna o total, o pico e o intervalo resolvido. ' +
        'ATENÇÃO: valores monetários voltam em CENTAVOS — divida por 100 antes de citar em reais.',
      inputSchema: z.object({
        metricId: z.string().describe('id exato da métrica, como devolvido por listar_metricas'),
        ...PeriodShape,
        granularity: GranularitySchema.optional(),
        filtros: z.record(z.string(), z.string()).optional()
          .describe('filtro por dimensão, ex.: { "campaign": "black-friday" }'),
      }),
      execute: instrument(context, 'consultar_metrica', async (input) => {
        const window = resolveWindow(input, today);

        const query: MetricQuery = {
          metricId: input.metricId,
          from: window.from, to: window.to, granularity: window.granularity,
          tenant,
          ...(input.filtros ? { filters: input.filtros } : {}),
        };

        const series = await gateway.queryMetric(query);

        // Resumo achatado: 90 pontos no contexto gastam tokens e não melhoram
        // a resposta. Total, pico e intervalo cobrem quase toda pergunta real.
        const peak = series.points.reduce(
          (best, point) => (point.value > best.value ? point : best),
          series.points[0] ?? { date: window.from, value: 0 },
        );

        return {
          metricId: series.metricId,
          unidade: series.unit,
          granularidade: series.granularity,
          total: series.total,
          periodo: { de: window.from, ate: window.to },
          pico: { data: peak.date, valor: peak.value },
          pontos: series.points.length,
          observacao: series.unit === 'currency'
            ? CENTS_NOTICE
            : 'Valores em unidade natural.',
        };
      }),
    }),

    ranking: tool({
      description:
        `Ranking em um período. Tipos disponíveis: ${RANKING_NAMES.join(', ')}. ` +
        'Use para perguntas do tipo "qual produto mais vendeu", "qual campanha trouxe mais ' +
        'receita", "quantos pedidos foram cancelados", "quais compras falharam".',
      inputSchema: z.object({
        tipo: z.string().describe(`um de: ${RANKING_NAMES.join(', ')}`),
        ...PeriodShape,
        limite: z.number().int().min(1).max(20).optional(),
      }),
      execute: instrument(context, 'ranking', async (input) => {
        const spec = RANKINGS[input.tipo];
        if (!spec) {
          throw new AgentGuidanceError(`ranking desconhecido: "${input.tipo}". Disponíveis: ${RANKING_NAMES.join(', ')}`);
        }

        const window = resolveWindow(input, today);
        const payload = await gateway.callTool<Record<string, unknown>>(
          spec.source, spec.tool,
          { from: window.from, to: window.to, limit: input.limite ?? 10, tenant },
          { cache: spec.tool !== 'failed_orders', rangeEnd: window.to },
        );

        // Algumas ferramentas devolvem `rows`, outras `groups`, `methods` ou
        // `orders`. Normalizamos para o modelo não precisar saber a diferença.
        const rows = (payload.rows ?? payload.groups ?? payload.methods ?? payload.orders ?? payload.products ?? []) as unknown[];
        const total = computeRankingTotal(spec.tool, payload, rows);

        return {
          tipo: input.tipo,
          descricao: spec.descricao,
          periodo: { de: window.from, ate: window.to },
          ...(total !== undefined ? { total } : {}),
          unidade: payload.unit ?? 'count',
          linhas: rows.slice(0, RANKING_ROWS_FOR_MODEL),
          observacao: payload.unit === 'currency' || hasCentsField(rows)
            ? CENTS_NOTICE
            : '',
        };
      }),
    }),

    funil_de_compra: tool({
      description:
        'Funil de compra do site/app no período (viu produto → carrinho → checkout → pagamento ' +
        '→ compra), com usuários por etapa e a etapa de maior abandono. Use para "qual etapa do ' +
        'checkout abandona mais", "quantos abandonaram o carrinho", "qual funil converte menos". ' +
        'IMPORTANTE: é agregado e NÃO identifica clientes individualmente — diga isso ao usuário.',
      inputSchema: z.object(PeriodShape),
      execute: instrument(context, 'funil_de_compra', async (input) => {
        const window = resolveWindow(input, today);
        return gateway.callTool<Record<string, unknown>>(
          'ga4', 'checkout_funnel',
          { from: window.from, to: window.to, tenant },
          { rangeEnd: window.to },
        );
      }),
    }),

    comparar_periodos: tool({
      description:
        'Compara produtos ou eventos entre dois períodos, do que MAIS CAIU (produtos) ou MAIS ' +
        'CRESCEU (eventos) para o resto. Use para "qual produto caiu mais em vendas" e "quais ' +
        'eventos cresceram após a atualização".',
      inputSchema: z.object({
        tipo: z.enum(['produtos', 'eventos']),
        periodoAnterior: z.string().describe('expressão de período, ex.: "mês passado"'),
        periodoAtual: z.string().describe('expressão de período, ex.: "este mês"'),
        limite: z.number().int().min(1).max(20).optional(),
      }),
      execute: instrument(context, 'comparar_periodos', async (input) => {
        const before = resolvePeriodPhrase(input.periodoAnterior, today);
        const current = resolvePeriodPhrase(input.periodoAtual, today);
        if (!before || !current) {
          throw new AgentGuidanceError(
            `não entendi um dos períodos ("${input.periodoAnterior}" / "${input.periodoAtual}"). ` +
            'Peça as datas exatas ao usuário.',
          );
        }
        // Mesmo teto de 400 dias das rotas HTTP: `compare_products`/
        // `compare_events` recebem `periodA`/`periodB` (não `from`/`to` no
        // nível raiz), então precisam ser checados aqui, não em `resolveWindow`.
        assertRange(before);
        assertRange(current);

        const isProducts = input.tipo === 'produtos';
        // `compare_products` compara por faturamento (padrão do servidor) — os
        // deltas voltam em centavos. `compare_events` é sempre contagem.
        const payload = await gateway.callTool<{ rows: unknown[]; unit?: string }>(
          isProducts ? 'commerce' : 'ga4',
          isProducts ? 'compare_products' : 'compare_events',
          {
            periodA: { from: before.from, to: before.to },
            periodB: { from: current.from, to: current.to },
            limit: input.limite ?? 10,
            tenant,
          },
          { rangeEnd: current.to },
        );

        return {
          tipo: input.tipo,
          periodoAnterior: { de: before.from, ate: before.to },
          periodoAtual: { de: current.from, ate: current.to },
          linhas: payload.rows.slice(0, RANKING_ROWS_FOR_MODEL),
          // `compare_products` não tem alternativa de unidade hoje: é sempre
          // receita, então é sempre centavos — mas checamos `payload.unit`
          // em vez de fixar `isProducts`, para não inventar a resposta se o
          // servidor um dia passar a aceitar orderBy=quantity.
          observacao: payload.unit === 'currency' ? CENTS_NOTICE : '',
        };
      }),
    }),

    correlacionar: tool({
      description:
        'Mede se duas métricas se moveram juntas no período, devolvendo um coeficiente de -1 a 1. ' +
        'Use para "o aumento de usuários impactou o faturamento". SEMPRE repita a ressalva de que ' +
        'correlação não prova causa.',
      inputSchema: z.object({
        metricaA: z.string().describe('id da primeira métrica'),
        metricaB: z.string().describe('id da segunda métrica'),
        ...PeriodShape,
        granularity: GranularitySchema.optional(),
      }),
      execute: instrument(context, 'correlacionar', async (input) => {
        const window = resolveWindow(input, today);
        const result = await correlateMetrics(gateway, {
          metricIdA: input.metricaA, metricIdB: input.metricaB,
          from: window.from, to: window.to, granularity: window.granularity, tenant,
        });

        return {
          metricaA: result.metricA, metricaB: result.metricB,
          periodo: { de: result.from, ate: result.to },
          pontos: result.buckets,
          coeficiente: result.coefficient,
          forca: result.strength,
          direcao: result.direction,
          ressalva: result.caveat,
          // `metricaA.total`/`metricaB.total` seguem em centavos quando a
          // unidade correspondente é "currency" — mesma regra de consultar_metrica.
          observacao: result.metricA.unit === 'currency' || result.metricB.unit === 'currency'
            ? `O campo "total" de metricaA/metricaB vem em CENTAVOS quando a unidade é "currency". ${CENTS_NOTICE}`
            : '',
        };
      }),
    }),

    impacto_da_versao: tool({
      description:
        'Compara faturamento, pedidos e usuários em janelas iguais antes e depois do lançamento ' +
        'de uma versão do app. Use para "quanto vendemos após a versão 5.8" e "a atualização ' +
        'aumentou as vendas". Se não souber a data de lançamento, pergunte ao usuário.',
      inputSchema: z.object({
        versao: z.string().describe('número da versão, ex.: "5.8.0"'),
        dataDeLancamento: z.string().describe('data do lançamento em YYYY-MM-DD'),
        janelaEmDias: z.number().int().min(3).max(90).optional(),
      }),
      execute: instrument(context, 'impacto_da_versao', async (input) => {
        const result = await analyzeAppVersionImpact({
          gateway, tenant, today,
          version: input.versao,
          releaseDate: input.dataDeLancamento,
          ...(input.janelaEmDias ? { windowDays: input.janelaEmDias } : {}),
        });

        return {
          versao: result.version,
          lancamento: result.releaseDate,
          janelaEmDias: result.windowDays,
          antes: result.before,
          depois: result.after,
          variacaoDeReceita: result.revenueDelta,
          variacaoPercentual: result.revenueDeltaRatio,
          adocao: result.adoption,
          veredito: result.verdict,
          ressalva: result.caveat,
          observacao: `Valores monetários em CENTAVOS — divida por 100 para reais.`,
        };
      }),
    }),

    caminho_ate_a_compra: tool({
      description:
        'Eventos que mais aparecem antes de uma compra, com a frequência entre os compradores. ' +
        'Use para "quais eventos antecedem uma compra".',
      inputSchema: z.object(PeriodShape),
      execute: instrument(context, 'caminho_ate_a_compra', async (input) => {
        const window = resolveWindow(input, today);
        return gateway.callTool<Record<string, unknown>>(
          'behavior', 'events_before_purchase',
          { from: window.from, to: window.to, tenant },
          { rangeEnd: window.to },
        );
      }),
    }),

    impacto_da_tela: tool({
      description:
        'Compara a taxa de compra de quem passou por uma tela com a de quem não passou. Use para ' +
        '"usuários que abandonam a tela X compram menos". SEMPRE repita a ressalva sobre causa.',
      inputSchema: z.object({ tela: z.string().describe('nome da tela ou página'), ...PeriodShape }),
      execute: instrument(context, 'impacto_da_tela', async (input) => {
        const window = resolveWindow(input, today);
        return gateway.callTool<Record<string, unknown>>(
          'behavior', 'screen_abandon_impact',
          { from: window.from, to: window.to, tela: input.tela, tenant },
          { rangeEnd: window.to },
        );
      }),
    }),
  };
}
