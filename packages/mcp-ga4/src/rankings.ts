import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import type { Ga4Row } from './client.js';
import type { Ga4ClientLike } from './interface.js';

const PeriodShape = { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema };
const PeriodSchema = z.object(PeriodShape).extend({
  limit: z.number().int().min(1).max(50).default(10),
});

const RankingOutputShape = {
  dimension: z.string(), from: z.string(), to: z.string(),
  total: z.number(), unit: z.string(),
  rows: z.array(z.object({
    key: z.string(), label: z.string(), value: z.number(),
    unit: z.string(), extra: z.record(z.string(), z.number()), share: z.number(),
  })),
};

/**
 * Para rankings cujo valor por linha é uma taxa (conversão, rejeição…), não um
 * total aditivo, somar as linhas e dividir cada uma pela soma produz um
 * `total`/`share` sem significado (ver achado B1 da revisão final de branch —
 * ex.: 3 dispositivos com taxas de 5%/10%/5% "somam" 20%, o que não existe).
 * `total`, quando presente, vem de `computeTotal` a partir dos contadores
 * brutos já buscados (nunca da soma das taxas); `share` nunca é emitido.
 */
const NonAdditiveRankingOutputShape = {
  dimension: z.string(), from: z.string(), to: z.string(),
  total: z.number().optional(), unit: z.string(),
  rows: z.array(z.object({
    key: z.string(), label: z.string(), value: z.number(),
    unit: z.string(), extra: z.record(z.string(), z.number()), share: z.number().optional(),
  })),
};

function requirePropertyId(tenant: { organizationId: string; externalIds: Record<string, string> }): string {
  const propertyId = tenant.externalIds.ga4PropertyId;
  if (!propertyId) {
    throw new Error(`ga4PropertyId não configurado para a organização "${tenant.organizationId}"`);
  }
  return propertyId;
}

interface RankingSpec {
  name: string;
  description: string;
  dimension: string;
  /** Métricas pedidas ao GA4. A primeira nomeia o valor principal, salvo `value`. */
  metrics: string[];
  unit: 'count' | 'ratio' | 'currency';
  /** Calcula o valor de ordenação a partir das métricas da linha. */
  value: (metrics: Record<string, number>) => number;
  /** Métricas secundárias expostas em `extra`. */
  extra: (metrics: Record<string, number>) => Record<string, number>;
  /** Descarta linhas irrelevantes, ex.: versão de app vazia vinda do tráfego web. */
  keep?: (key: string) => boolean;
  /**
   * Falso quando `value` é uma taxa (não um total aditivo entre linhas) —
   * conversão, rejeição… Nesse caso `share` nunca é emitido, e `total` só é
   * emitido se `computeTotal` for informado.
   */
  additive?: boolean;
  /**
   * Só usado quando `additive` é falso. Deriva um `total` correto (ex.:
   * conversões totais / sessões totais) a partir das linhas já buscadas
   * nesta mesma consulta — nunca de uma chamada extra ao GA4. Quando não é
   * possível calcular um total correto com os dados já em mãos (ex.:
   * `page_performance`, que não busca sessões por página), o spec
   * simplesmente não fornece esta função e `total` fica de fora da resposta.
   */
  computeTotal?: (mapped: Array<{ value: number; extra: Record<string, number> }>) => number;
}

/**
 * Fábrica de rankings por dimensão. Seis das sete ferramentas desta task são a
 * mesma consulta com dimensão e métrica diferentes — escrevê-las à mão seria
 * repetir o mesmo bug seis vezes.
 */
export function createDimensionRankingTool(client: Ga4ClientLike, spec: RankingSpec): AnalysisTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: (spec.additive ?? true) ? RankingOutputShape : NonAdditiveRankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const propertyId = requirePropertyId(tenant);

      const rows = await client.runReport({
        propertyId,
        metricNames: spec.metrics,
        from, to,
        dimensionNames: [spec.dimension],
        dimensionFilters: {},
      });

      const mapped = rows
        .map((row: Ga4Row) => ({
          key: row.dimensions[spec.dimension] ?? '',
          value: spec.value(row.metrics),
          extra: spec.extra(row.metrics),
        }))
        .filter((row) => (spec.keep ? spec.keep(row.key) : row.key !== ''));

      const additive = spec.additive ?? true;
      const total = additive
        ? mapped.reduce((acc, row) => acc + row.value, 0)
        : spec.computeTotal?.(mapped);

      return {
        dimension: spec.dimension,
        from, to, unit: spec.unit,
        ...(total !== undefined ? { total } : {}),
        rows: [...mapped]
          .sort((a, b) => b.value - a.value)
          .slice(0, limit)
          .map((row) => ({
            key: row.key,
            label: row.key,
            value: row.value,
            unit: spec.unit,
            extra: row.extra,
            ...(additive ? { share: total === 0 ? 0 : row.value / (total as number) } : {}),
          })),
      };
    },
  };
}

export function createTrafficSourcesTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'traffic_sources',
    description: 'Ranking de origens de tráfego (origem/mídia) por usuários no período. Use para "qual origem trouxe mais usuários".',
    dimension: 'sessionSourceMedium',
    metrics: ['sessions', 'activeUsers'],
    unit: 'count',
    value: (m) => m.activeUsers ?? 0,
    extra: (m) => ({ sessions: m.sessions ?? 0, users: m.activeUsers ?? 0 }),
  });
}

export function createCampaignUsersTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'campaign_users',
    description: 'Ranking de campanhas por usuários e sessões no período. Use para "qual campanha trouxe mais usuários". Para receita por campanha, use campaign_revenue (fonte Uappi).',
    dimension: 'sessionCampaignName',
    metrics: ['sessions', 'activeUsers'],
    unit: 'count',
    value: (m) => m.activeUsers ?? 0,
    extra: (m) => ({ sessions: m.sessions ?? 0, users: m.activeUsers ?? 0 }),
  });
}

export function createDevicePerformanceTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'device_performance',
    description:
      'Taxa de conversão por dispositivo (conversões sobre sessões) no período. Use ' +
      'para "qual dispositivo converte melhor". O valor de cada linha é a taxa do ' +
      'dispositivo, de 0 a 1. `total` é a taxa de conversão geral do período ' +
      '(conversões totais / sessões totais, de todos os dispositivos), não a soma ' +
      'das taxas de cada linha. `share` não é reportado por linha: taxa de conversão ' +
      'não é aditiva entre dispositivos — some as sessões/conversões de `extra` se ' +
      'precisar de uma agregação diferente.',
    dimension: 'deviceCategory',
    metrics: ['sessions', 'activeUsers', 'conversions'],
    unit: 'ratio',
    value: (m) => (m.sessions ? (m.conversions ?? 0) / m.sessions : 0),
    extra: (m) => ({ sessions: m.sessions ?? 0, users: m.activeUsers ?? 0, conversions: m.conversions ?? 0 }),
    additive: false,
    // Taxa de conversão geral: conversões totais / sessões totais de TODOS os
    // dispositivos (não só do top N exibido) — já estão em `extra`, sem
    // chamada extra ao GA4.
    computeTotal: (mapped) => {
      const sessions = mapped.reduce((acc, row) => acc + (row.extra.sessions ?? 0), 0);
      const conversions = mapped.reduce((acc, row) => acc + (row.extra.conversions ?? 0), 0);
      return sessions === 0 ? 0 : conversions / sessions;
    },
  });
}

export function createPagePerformanceTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'page_performance',
    description:
      'Páginas com maior taxa de rejeição no período, da pior para a melhor. Use para ' +
      '"qual página possui maior abandono". O valor de cada linha é a taxa de rejeição ' +
      'da página, de 0 a 1. Nem `total` nem `share` são reportados: taxa de rejeição ' +
      'não é aditiva entre páginas, e um total correto exigiria sessões por página, ' +
      'que esta consulta não busca — avalie cada página pelo valor da própria linha.',
    dimension: 'pagePath',
    metrics: ['screenPageViews', 'bounceRate'],
    unit: 'ratio',
    value: (m) => m.bounceRate ?? 0,
    extra: (m) => ({ pageViews: m.screenPageViews ?? 0 }),
    additive: false,
    // Sem computeTotal: não há sessões por página nos dados buscados, então
    // não existe total correto derivável sem uma chamada extra ao GA4 — e
    // "omitir" é a regra do achado B1, nunca fabricar um número.
  });
}

export function createAppVersionsTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'app_versions',
    description: 'Usuários ativos por versão do aplicativo no período. Use para "qual versão do app possui mais usuários".',
    dimension: 'appVersion',
    metrics: ['activeUsers', 'sessions'],
    unit: 'count',
    value: (m) => m.activeUsers ?? 0,
    extra: (m) => ({ sessions: m.sessions ?? 0 }),
    // Tráfego web chega com appVersion vazia; incluí-la dominaria o ranking.
    keep: (key) => key !== '' && key !== '(not set)',
  });
}

export function createTopEventsTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'top_events',
    description: 'Eventos mais registrados no período, com contagem e usuários. Use para "quais eventos ocorreram hoje".',
    dimension: 'eventName',
    metrics: ['eventCount', 'activeUsers'],
    unit: 'count',
    value: (m) => m.eventCount ?? 0,
    extra: (m) => ({ users: m.activeUsers ?? 0 }),
  });
}

export function createCompareEventsTool(client: Ga4ClientLike): AnalysisTool {
  const InputSchema = z.object({
    tenant: TenantContextSchema,
    periodA: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
    periodB: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
    limit: z.number().int().min(1).max(50).default(10),
  });

  return {
    name: 'compare_events',
    description:
      'Compara a contagem de cada evento entre dois períodos, ordenando pelo MAIOR CRESCIMENTO ' +
      'primeiro. Use para "quais eventos cresceram após a última atualização" — periodA é antes ' +
      'da atualização, periodB depois.',
    inputSchema: {
      tenant: TenantContextSchema,
      periodA: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
      periodB: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
      limit: z.number().optional(),
    },
    outputSchema: {
      dimension: z.string(),
      periodA: z.object({ from: z.string(), to: z.string() }),
      periodB: z.object({ from: z.string(), to: z.string() }),
      unit: z.string(),
      rows: z.array(z.object({
        key: z.string(), label: z.string(),
        valueA: z.number(), valueB: z.number(),
        delta: z.number(), deltaRatio: z.number().nullable(),
      })),
    },
    handler: async (args) => {
      const { tenant, periodA, periodB, limit } = InputSchema.parse(args);
      const propertyId = requirePropertyId(tenant);

      const request = (period: { from: string; to: string }) =>
        client.runReport({
          propertyId,
          metricNames: ['eventCount'],
          from: period.from, to: period.to,
          dimensionNames: ['eventName'],
          dimensionFilters: {},
        });

      const [rowsA, rowsB] = await Promise.all([request(periodA), request(periodB)]);

      const toMap = (rows: Ga4Row[]) =>
        new Map(rows.map((row) => [row.dimensions.eventName ?? '', row.metrics.eventCount ?? 0]));

      const mapA = toMap(rowsA);
      const mapB = toMap(rowsB);
      // União: um evento que sumiu é informação, não ruído.
      const keys = [...new Set([...mapA.keys(), ...mapB.keys()])].filter((key) => key !== '');

      const rows = keys.map((key) => {
        const valueA = mapA.get(key) ?? 0;
        const valueB = mapB.get(key) ?? 0;
        return {
          key, label: key, valueA, valueB,
          delta: valueB - valueA,
          deltaRatio: valueA === 0 ? null : (valueB - valueA) / valueA,
        };
      });

      // Maior crescimento primeiro: é a pergunta que motiva a ferramenta.
      rows.sort((left, right) => right.delta - left.delta);

      return { dimension: 'eventName', periodA, periodB, unit: 'count', rows: rows.slice(0, limit) };
    },
  };
}
