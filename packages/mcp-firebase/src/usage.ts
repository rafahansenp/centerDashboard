import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import type { Ga4ClientLike } from '@center/mcp-ga4';

const PeriodShape = { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema };
const PeriodSchema = z.object(PeriodShape).extend({
  limit: z.number().int().min(1).max(50).default(20),
});

function requirePropertyId(tenant: { organizationId: string; externalIds: Record<string, string> }): string {
  const propertyId = tenant.externalIds.ga4AppPropertyId;
  if (!propertyId) {
    throw new Error(`ga4AppPropertyId não configurado para a organização "${tenant.organizationId}"`);
  }
  return propertyId;
}

/**
 * Ranking de uso por evento (cadastro, níveis de treino, alimentos, dietas,
 * treinos, exercícios) no período — cobre os indicadores "SE POSSÍVEL POR
 * DATA E POR VERSÃO" da planilha original que não são o funil da loja.
 */
export function createUsageSummaryTool(client: Ga4ClientLike): AnalysisTool {
  return {
    name: 'usage_summary',
    description:
      'Ranking de eventos de uso do app (cadastro, níveis de treino, alimentos, dietas, ' +
      'treinos, exercícios) por usuários ativos no período. Use para "quantos usuários ' +
      'usaram cada módulo do app".',
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: {
      dimension: z.string(), from: z.string(), to: z.string(),
      total: z.number(), unit: z.string(),
      rows: z.array(z.object({
        key: z.string(), label: z.string(), value: z.number(),
        unit: z.string(), extra: z.record(z.string(), z.number()), share: z.number(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const propertyId = requirePropertyId(tenant);

      const rows = await client.runReport({
        propertyId,
        metricNames: ['activeUsers', 'eventCount'],
        from, to,
        dimensionNames: ['eventName'],
        dimensionFilters: {},
      });

      const mapped = rows
        .map((row) => ({
          key: row.dimensions.eventName ?? '',
          value: row.metrics.activeUsers ?? 0,
          extra: { eventCount: row.metrics.eventCount ?? 0 },
        }))
        .filter((row) => row.key !== '');

      const total = mapped.reduce((acc, row) => acc + row.value, 0);

      return {
        dimension: 'eventName', from, to, unit: 'count', total,
        rows: [...mapped]
          .sort((a, b) => b.value - a.value)
          .slice(0, limit)
          .map((row) => ({
            key: row.key, label: row.key, value: row.value, unit: 'count',
            extra: row.extra, share: total === 0 ? 0 : row.value / total,
          })),
      };
    },
  };
}
