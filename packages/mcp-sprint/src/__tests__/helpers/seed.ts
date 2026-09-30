import { PrismaClient } from '@prisma/client';

export const TEST_ORG = 'org_test_sprint';

export const prisma = new PrismaClient();

export async function resetSprintData(): Promise<void> {
  await prisma.sprintTask.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.sprintCycle.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.organization.upsert({
    where: { id: TEST_ORG },
    update: {},
    create: { id: TEST_ORG, name: 'Org de Teste (Sprint)' },
  });
}

export interface SeedTask {
  externalId: string;
  title: string;
  area: 'FRONT' | 'BACK';
  type: 'MELHORIA' | 'CORRECAO' | 'BUGFIX' | 'MODULO';
  status: 'PLANEJADO' | 'ADICIONAL' | 'ENTREGUE';
  sprintNumber?: number | null;
  bugfixEnvironment?: 'TESTE' | 'PRODUCAO' | null;
  createdAtLocal: string;
  deliveredAtLocal?: string | null;
}

function toUtc(local: string): Date {
  return new Date(`${local}-03:00`);
}

export async function seedTasks(tasks: SeedTask[]): Promise<void> {
  for (const task of tasks) {
    await prisma.sprintTask.create({
      data: {
        organizationId: TEST_ORG,
        externalId: task.externalId,
        title: task.title,
        area: task.area,
        type: task.type,
        status: task.status,
        sprintNumber: task.sprintNumber ?? null,
        bugfixEnvironment: task.bugfixEnvironment ?? null,
        createdAt: toUtc(task.createdAtLocal),
        deliveredAt: task.deliveredAtLocal ? toUtc(task.deliveredAtLocal) : null,
        rawPayload: {},
      },
    });
  }
}

export interface SeedCycle {
  sprintNumber: number;
  totalTasks: number;
  planned: number;
  carriedFromPrevious: number;
  additionalTasks: number;
  completed: number;
  carriedToNext: number;
  bugfixTest: number;
  bugfixProduction: number;
  startDateLocal?: string | null;
  endDateLocal?: string | null;
}

export async function seedCycles(cycles: SeedCycle[]): Promise<void> {
  for (const cycle of cycles) {
    await prisma.sprintCycle.create({
      data: {
        organizationId: TEST_ORG,
        sprintNumber: cycle.sprintNumber,
        totalTasks: cycle.totalTasks,
        planned: cycle.planned,
        carriedFromPrevious: cycle.carriedFromPrevious,
        additionalTasks: cycle.additionalTasks,
        completed: cycle.completed,
        carriedToNext: cycle.carriedToNext,
        bugfixTest: cycle.bugfixTest,
        bugfixProduction: cycle.bugfixProduction,
        startDate: cycle.startDateLocal ? toUtc(cycle.startDateLocal) : null,
        endDate: cycle.endDateLocal ? toUtc(cycle.endDateLocal) : null,
        rawPayload: {},
      },
    });
  }
}
