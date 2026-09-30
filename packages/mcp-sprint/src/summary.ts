import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { AREA_LABEL, STATUS_LABEL, TYPE_LABEL, rangeToUtc } from './constants.js';

const InputSchema = z.object({
  from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema,
  sprintNumber: z.number().int().optional(),
});

const CountRow = z.object({ key: z.string(), label: z.string(), count: z.number() });

/**
 * Totais do sprint (TOTAL PLANEJADO/ADICIONAL/ENTREGUE, BUGFIX, CORREÇÕES,
 * MÓDULOS, FRONT/BACK) — todos derivados de `groupBy`, nunca pré-agregados,
 * para nunca ficarem desatualizados em relação ao Monday.com.
 */
export function createSprintSummaryTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'sprint_summary',
    description:
      'Totais de tarefas do sprint (planejado/adicional/entregue, por tipo e por área) ' +
      'criadas no período. Use para "quanto foi planejado e quanto foi entregue neste ' +
      'sprint". Filtre por sprintNumber para um ciclo específico do Monday.com.',
    inputSchema: { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema, sprintNumber: z.number().optional() },
    outputSchema: {
      from: z.string(), to: z.string(), sprintNumber: z.number().nullable(), total: z.number(),
      byStatus: z.array(CountRow), byType: z.array(CountRow), byArea: z.array(CountRow),
    },
    handler: async (args) => {
      const { from, to, tenant, sprintNumber } = InputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      const where = {
        organizationId: tenant.organizationId,
        createdAt: { gte: start, lt: end },
        ...(sprintNumber !== undefined ? { sprintNumber } : {}),
      };

      const [byStatus, byType, byArea, total] = await Promise.all([
        prisma.sprintTask.groupBy({ by: ['status'], where, _count: { _all: true } }),
        prisma.sprintTask.groupBy({ by: ['type'], where, _count: { _all: true } }),
        prisma.sprintTask.groupBy({ by: ['area'], where, _count: { _all: true } }),
        prisma.sprintTask.count({ where }),
      ]);

      const byCount = (a: { _count: { _all: number } }, b: { _count: { _all: number } }) => b._count._all - a._count._all;

      return {
        from, to, sprintNumber: sprintNumber ?? null, total,
        byStatus: [...byStatus].sort(byCount).map((row) => ({
          key: row.status, label: STATUS_LABEL[row.status] ?? row.status, count: row._count._all,
        })),
        byType: [...byType].sort(byCount).map((row) => ({
          key: row.type, label: TYPE_LABEL[row.type] ?? row.type, count: row._count._all,
        })),
        byArea: [...byArea].sort(byCount).map((row) => ({
          key: row.area, label: AREA_LABEL[row.area] ?? row.area, count: row._count._all,
        })),
      };
    },
  };
}
