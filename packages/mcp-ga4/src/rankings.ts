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
    outputSchema: RankingOutputShape,
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

      const total = mapped.reduce((acc, row) => acc + row.value, 0);

      return {
        dimension: spec.dimension,
        from, to, total, unit: spec.unit,
        rows: [...mapped]
          .sort((a, b) => b.value - a.value)
          .slice(0, limit)
          .map((row) => ({
            key: row.key,
            label: row.key,
            value: row.value,
            unit: spec.unit,
            extra: row.extra,
            share: total === 0 ? 0 : row.value / total,
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
    description: 'Taxa de conversão por dispositivo (conversões sobre sessões) no período. Use para "qual dispositivo converte melhor". O valor é a taxa, de 0 a 1.',
    dimension: 'deviceCategory',
    metrics: ['sessions', 'activeUsers', 'conversions'],
    unit: 'ratio',
    value: (m) => (m.sessions ? (m.conversions ?? 0) / m.sessions : 0),
    extra: (m) => ({ sessions: m.sessions ?? 0, users: m.activeUsers ?? 0, conversions: m.conversions ?? 0 }),
  });
}

export function createPagePerformanceTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'page_performance',
    description: 'Páginas com maior taxa de rejeição no período, da pior para a melhor. Use para "qual página possui maior abandono". O valor é a taxa de rejeição, de 0 a 1.',
    dimension: 'pagePath',
    metrics: ['screenPageViews', 'bounceRate'],
    unit: 'ratio',
    value: (m) => m.bounceRate ?? 0,
    extra: (m) => ({ pageViews: m.screenPageViews ?? 0 }),
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
