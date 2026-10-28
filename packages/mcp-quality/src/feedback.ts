import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { rangeToUtc } from './constants.js';

const OriginSchema = z.enum(['STORE_ANDROID', 'STORE_IOS', 'MARKETPLACE']);

const InputSchema = z.object({
  from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema,
  origin: OriginSchema.optional(),
});

const CATEGORY_LABEL: Record<string, string> = {
  CRITICA: 'Crítica',
  ERRO: 'Erro',
  SUGESTAO: 'Sugestão',
  ELOGIO: 'Elogio',
  OUTRO: 'Outro',
};

/**
 * % de feedback por categoria (crítica, erro, sugestão, elogio, outro), vindo
 * do console da loja e/ou do painel de marketplace da Uappi. `share` sempre
 * de um `groupBy`, nunca pré-agregado — ver `AppFeedback` no schema.
 */
export function createFeedbackByCategoryTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'feedback_by_category',
    description:
      'Distribuição do feedback (reviews da loja e/ou marketplace) por categoria no ' +
      'período. Use para "que tipo de feedback os usuários mais deixaram". Filtre por ' +
      'origin para separar loja de marketplace.',
    inputSchema: { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema, origin: OriginSchema.optional() },
    outputSchema: {
      dimension: z.string(), from: z.string(), to: z.string(),
      total: z.number(), unit: z.string(),
      rows: z.array(z.object({
        key: z.string(), label: z.string(), value: z.number(),
        unit: z.string(), extra: z.record(z.string(), z.number()), share: z.number(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant, origin } = InputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      const grouped = await prisma.appFeedback.groupBy({
        by: ['category'],
        where: {
          organizationId: tenant.organizationId,
          occurredAt: { gte: start, lt: end },
          ...(origin ? { origin } : {}),
        },
        _count: { _all: true },
      });

      const total = grouped.reduce((acc, row) => acc + row._count._all, 0);

      return {
        dimension: 'category', from, to, unit: 'count', total,
        rows: [...grouped]
          .sort((a, b) => b._count._all - a._count._all)
          .map((row) => ({
            key: row.category,
            label: CATEGORY_LABEL[row.category] ?? row.category,
            value: row._count._all,
            unit: 'count',
            extra: {},
            share: total === 0 ? 0 : row._count._all / total,
          })),
      };
    },
  };
}
