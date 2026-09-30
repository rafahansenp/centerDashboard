import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { rangeToUtc } from './constants.js';

const AreaSchema = z.enum(['FRONT', 'BACK']);
const TypeSchema = z.enum(['MELHORIA', 'CORRECAO', 'BUGFIX', 'MODULO']);
const StatusSchema = z.enum(['PLANEJADO', 'ADICIONAL', 'ENTREGUE']);

const InputSchema = z.object({
  from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema,
  sprintNumber: z.number().int().optional(),
  area: AreaSchema.optional(),
  type: TypeSchema.optional(),
  status: StatusSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

/** Lista bruta de tarefas do sprint, para uma tabela de detalhe por trás dos totais de `sprint_summary`. */
export function createSprintTasksTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'sprint_tasks',
    description:
      'Lista as tarefas do sprint criadas no período, com área, tipo e status. Use para ' +
      '"quais tarefas de bugfix estão nesse sprint". Filtre por sprintNumber/area/type/status.',
    inputSchema: {
      from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema,
      sprintNumber: z.number().optional(), area: AreaSchema.optional(),
      type: TypeSchema.optional(), status: StatusSchema.optional(), limit: z.number().optional(),
    },
    outputSchema: {
      from: z.string(), to: z.string(), total: z.number(),
      tasks: z.array(z.object({
        externalId: z.string(), title: z.string(), area: z.string(), type: z.string(),
        status: z.string(), sprintNumber: z.number().nullable(),
        createdAt: z.string(), deliveredAt: z.string().nullable(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant, sprintNumber, area, type, status, limit } = InputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      const where = {
        organizationId: tenant.organizationId,
        createdAt: { gte: start, lt: end },
        ...(sprintNumber !== undefined ? { sprintNumber } : {}),
        ...(area ? { area } : {}),
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
      };

      const [total, tasks] = await Promise.all([
        prisma.sprintTask.count({ where }),
        prisma.sprintTask.findMany({
          where, orderBy: { createdAt: 'desc' }, take: limit,
          select: {
            externalId: true, title: true, area: true, type: true, status: true,
            sprintNumber: true, createdAt: true, deliveredAt: true,
          },
        }),
      ]);

      return {
        from, to, total,
        tasks: tasks.map((task) => ({
          externalId: task.externalId, title: task.title, area: task.area, type: task.type,
          status: task.status, sprintNumber: task.sprintNumber,
          createdAt: task.createdAt.toISOString(), deliveredAt: task.deliveredAt ? task.deliveredAt.toISOString() : null,
        })),
      };
    },
  };
}
