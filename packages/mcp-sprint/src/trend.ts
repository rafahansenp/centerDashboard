import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { rangeToUtc } from './constants.js';

const InputSchema = z.object({ from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema });

/**
 * Rótulo de cada tipo de tarefa PARA GRÁFICO — não é o mesmo texto de
 * `TYPE_LABEL` (usado na tabela de tarefas): aqui BUGFIX vira "Análises" e
 * MODULO vira "Tasks", para bater com a nomenclatura que o time já usa nos
 * relatórios de sprint.
 */
export const CHART_TYPE_LABEL: Record<string, string> = {
  MODULO: 'Tasks',
  MELHORIA: 'Melhorias',
  BUGFIX: 'Análises',
  CORRECAO: 'Correção',
};

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

/**
 * Contagem de tarefas por tipo e por mês (para os 4 gráficos de linha:
 * Tasks/Melhorias/Análises/Correção). Meses sem nenhuma tarefa de um tipo não
 * aparecem — o cliente decide se preenche com zero.
 */
export function createSprintTypeTrendTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'sprint_type_trend',
    description:
      'Contagem de tarefas do sprint por tipo (Tasks, Melhorias, Análises, Correção) e por mês, ' +
      'no período. Use para "como o volume de bugfix evoluiu nos últimos meses".',
    inputSchema: { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema },
    outputSchema: {
      from: z.string(), to: z.string(),
      points: z.array(z.object({ month: z.string(), type: z.string(), label: z.string(), count: z.number() })),
    },
    handler: async (args) => {
      const { from, to, tenant } = InputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      const tasks = await prisma.sprintTask.findMany({
        where: { organizationId: tenant.organizationId, createdAt: { gte: start, lt: end } },
        select: { type: true, createdAt: true },
      });

      const counts = new Map<string, number>();
      for (const task of tasks) {
        const key = `${monthKey(task.createdAt)}|${task.type}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      const points = [...counts.entries()]
        .map(([key, count]) => {
          const [month, type] = key.split('|') as [string, string];
          return { month, type, label: CHART_TYPE_LABEL[type] ?? type, count };
        })
        .sort((a, b) => (a.month === b.month ? a.type.localeCompare(b.type) : a.month.localeCompare(b.month)));

      return { from, to, points };
    },
  };
}
