import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';

const InputSchema = z.object({
  tenant: TenantContextSchema,
  limit: z.number().int().min(1).max(100).default(24),
});

const CycleSchema = z.object({
  sprintNumber: z.number(),
  totalTasks: z.number(),
  planned: z.number(),
  carriedFromPrevious: z.number(),
  additionalTasks: z.number(),
  completed: z.number(),
  carriedToNext: z.number(),
  bugfixTest: z.number(),
  bugfixProduction: z.number(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  correctionsCount: z.number(),
  corrections: z.array(z.object({ title: z.string() })),
});

/**
 * Resumo por sprint — "vieram/vão para a próxima sprint" é estado do board do
 * Monday.com, gravado direto em `SprintCycle` (não dá pra derivar de
 * SprintTask). As correções, por outro lado, vêm de SprintTask
 * (type=CORRECAO) filtradas pelo mesmo sprintNumber — nunca duplicadas aqui.
 * Não é filtrado por período: sprint é numerada, não bucketizada por dia.
 */
export function createSprintCyclesTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'sprint_cycles',
    description:
      'Resumo por sprint (planejadas, vieram/vão para a próxima sprint, bugfix em teste e em ' +
      'produção, tarefas de correção), das sprints mais recentes. Use para "o que aconteceu na ' +
      'sprint 92" ou para montar um relatório por sprint.',
    inputSchema: { tenant: TenantContextSchema, limit: z.number().optional() },
    outputSchema: { cycles: z.array(CycleSchema) },
    handler: async (args) => {
      const { tenant, limit } = InputSchema.parse(args);

      const cycles = await prisma.sprintCycle.findMany({
        where: { organizationId: tenant.organizationId },
        orderBy: { sprintNumber: 'desc' },
        take: limit,
      });

      const sprintNumbers = cycles.map((c) => c.sprintNumber);
      const corrections = sprintNumbers.length > 0
        ? await prisma.sprintTask.findMany({
          where: {
            organizationId: tenant.organizationId,
            type: 'CORRECAO',
            sprintNumber: { in: sprintNumbers },
          },
          select: { sprintNumber: true, title: true },
          orderBy: { createdAt: 'asc' },
        })
        : [];

      const correctionsBySprintNumber = new Map<number, Array<{ title: string }>>();
      for (const correction of corrections) {
        if (correction.sprintNumber === null) continue;
        const list = correctionsBySprintNumber.get(correction.sprintNumber) ?? [];
        list.push({ title: correction.title });
        correctionsBySprintNumber.set(correction.sprintNumber, list);
      }

      return {
        // Ascendente: é a ordem que um gráfico "Tasks por Sprint" e uma
        // listagem cronológica de relatórios esperam.
        cycles: [...cycles].reverse().map((cycle) => {
          const cycleCorrections = correctionsBySprintNumber.get(cycle.sprintNumber) ?? [];
          return {
            sprintNumber: cycle.sprintNumber,
            totalTasks: cycle.totalTasks,
            planned: cycle.planned,
            carriedFromPrevious: cycle.carriedFromPrevious,
            additionalTasks: cycle.additionalTasks,
            completed: cycle.completed,
            carriedToNext: cycle.carriedToNext,
            bugfixTest: cycle.bugfixTest,
            bugfixProduction: cycle.bugfixProduction,
            startDate: cycle.startDate ? cycle.startDate.toISOString().slice(0, 10) : null,
            endDate: cycle.endDate ? cycle.endDate.toISOString().slice(0, 10) : null,
            correctionsCount: cycleCorrections.length,
            corrections: cycleCorrections,
          };
        }),
      };
    },
  };
}
