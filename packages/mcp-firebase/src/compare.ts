import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import type { Ga4ClientLike } from '@center/mcp-ga4';

function requirePropertyId(tenant: { organizationId: string; externalIds: Record<string, string> }): string {
  const propertyId = tenant.externalIds.ga4AppPropertyId;
  if (!propertyId) {
    throw new Error(`ga4AppPropertyId não configurado para a organização "${tenant.organizationId}"`);
  }
  return propertyId;
}

/**
 * Compara cada evento entre DUAS VERSÕES do app (não dois períodos — para
 * isso, GA4 web já tem `compare_events`), no mesmo intervalo de datas. Espelha
 * a tabela dupla da planilha original (contagem bruta E % do total de
 * usuários por versão).
 */
export function createCompareByVersionTool(client: Ga4ClientLike): AnalysisTool {
  const InputSchema = z.object({
    tenant: TenantContextSchema,
    from: IsoDateSchema, to: IsoDateSchema,
    versionA: z.string().min(1),
    versionB: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(20),
  });

  return {
    name: 'compare_by_version',
    description:
      'Compara a contagem de cada evento do app entre duas versões (ex.: penúltima vs. ' +
      'atual), no mesmo período, com contagem bruta e % do total de usuários daquela ' +
      'versão. Use para "o uso caiu na última atualização".',
    inputSchema: {
      tenant: TenantContextSchema,
      from: IsoDateSchema, to: IsoDateSchema,
      versionA: z.string(), versionB: z.string(),
      limit: z.number().optional(),
    },
    outputSchema: {
      dimension: z.string(), from: z.string(), to: z.string(),
      versionA: z.string(), versionB: z.string(),
      rows: z.array(z.object({
        key: z.string(), label: z.string(),
        valueA: z.number(), valueB: z.number(),
        shareA: z.number(), shareB: z.number(),
        delta: z.number(), deltaRatio: z.number().nullable(),
      })),
    },
    handler: async (args) => {
      const { tenant, from, to, versionA, versionB, limit } = InputSchema.parse(args);
      const propertyId = requirePropertyId(tenant);

      const request = (appVersion: string) =>
        client.runReport({
          propertyId,
          metricNames: ['activeUsers'],
          from, to,
          dimensionNames: ['eventName'],
          dimensionFilters: { appVersion },
        });

      const [rowsA, rowsB] = await Promise.all([request(versionA), request(versionB)]);

      const toMap = (rows: Awaited<ReturnType<typeof request>>) =>
        new Map(rows.map((row) => [row.dimensions.eventName ?? '', row.metrics.activeUsers ?? 0]));

      const mapA = toMap(rowsA);
      const mapB = toMap(rowsB);
      // "Total de usuários" da versão: o maior valor de evento único já
      // buscado (nenhuma chamada extra ao GA4). Garante shareA/shareB <= 1 —
      // um evento nunca pode ter mais usuários que o mais usado da mesma
      // versão. Sem isso, duas consultas hash independentes (uma por evento,
      // outra pelo "total") podiam produzir números incoerentes entre si.
      const totalUsersA = Math.max(0, ...mapA.values());
      const totalUsersB = Math.max(0, ...mapB.values());

      const keys = [...new Set([...mapA.keys(), ...mapB.keys()])].filter((key) => key !== '');

      const rows = keys.map((key) => {
        const valueA = mapA.get(key) ?? 0;
        const valueB = mapB.get(key) ?? 0;
        return {
          key, label: key, valueA, valueB,
          shareA: totalUsersA === 0 ? 0 : valueA / totalUsersA,
          shareB: totalUsersB === 0 ? 0 : valueB / totalUsersB,
          delta: valueB - valueA,
          deltaRatio: valueA === 0 ? null : (valueB - valueA) / valueA,
        };
      });

      rows.sort((left, right) => right.valueB - left.valueB);

      return { dimension: 'eventName', from, to, versionA, versionB, rows: rows.slice(0, limit) };
    },
  };
}
