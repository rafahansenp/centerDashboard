import { createSprintCyclesTool } from '../cycles.js';
import { prisma, resetSprintData, seedCycles, seedTasks, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };

beforeAll(async () => {
  await resetSprintData();
  await seedCycles([
    {
      sprintNumber: 77, totalTasks: 20, planned: 18, carriedFromPrevious: 0, additionalTasks: 2,
      completed: 17, carriedToNext: 3, bugfixTest: 1, bugfixProduction: 0,
      startDateLocal: '2026-08-01T09:00:00', endDateLocal: '2026-08-07T18:00:00',
    },
    {
      sprintNumber: 78, totalTasks: 25, planned: 19, carriedFromPrevious: 3, additionalTasks: 3,
      completed: 22, carriedToNext: 3, bugfixTest: 0, bugfixProduction: 2,
      startDateLocal: '2026-08-08T09:00:00', endDateLocal: '2026-08-14T18:00:00',
    },
  ]);
  await seedTasks([
    { externalId: 'c1', title: 'Corrige texto A', area: 'FRONT', type: 'CORRECAO', status: 'ENTREGUE', sprintNumber: 77, createdAtLocal: '2026-08-02T10:00:00' },
    { externalId: 'c2', title: 'Corrige texto B', area: 'BACK', type: 'CORRECAO', status: 'ENTREGUE', sprintNumber: 77, createdAtLocal: '2026-08-03T10:00:00' },
    { externalId: 'm1', title: 'Módulo qualquer', area: 'FRONT', type: 'MODULO', status: 'ENTREGUE', sprintNumber: 77, createdAtLocal: '2026-08-02T10:00:00' },
    { externalId: 'b1', title: 'Bugfix qualquer', area: 'BACK', type: 'BUGFIX', status: 'ENTREGUE', bugfixEnvironment: 'PRODUCAO', sprintNumber: 78, createdAtLocal: '2026-08-09T10:00:00' },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

describe('sprint_cycles', () => {
  const tool = createSprintCyclesTool(prisma);

  it('is named sprint_cycles', () => {
    expect(tool.name).toBe('sprint_cycles');
  });

  it('returns cycles in ascending sprintNumber order', async () => {
    const result = await tool.handler({ tenant }) as { cycles: Array<{ sprintNumber: number }> };
    expect(result.cycles.map((c) => c.sprintNumber)).toEqual([77, 78]);
  });

  it('carries the exact report numbers from the board — never recomputed from SprintTask', async () => {
    const result = await tool.handler({ tenant }) as {
      cycles: Array<{ sprintNumber: number; carriedFromPrevious: number; carriedToNext: number; planned: number }>;
    };
    const sprint78 = result.cycles.find((c) => c.sprintNumber === 78);
    expect(sprint78).toMatchObject({ carriedFromPrevious: 3, carriedToNext: 3, planned: 19 });
  });

  it('attaches only CORRECAO tasks from the same sprintNumber, never other types', async () => {
    const result = await tool.handler({ tenant }) as {
      cycles: Array<{ sprintNumber: number; correctionsCount: number; corrections: Array<{ title: string }> }>;
    };
    const sprint77 = result.cycles.find((c) => c.sprintNumber === 77)!;
    expect(sprint77.correctionsCount).toBe(2);
    expect(sprint77.corrections.map((c) => c.title)).toEqual(['Corrige texto A', 'Corrige texto B']);

    const sprint78 = result.cycles.find((c) => c.sprintNumber === 78)!;
    expect(sprint78.correctionsCount).toBe(0);
  });

  it('respects limit', async () => {
    const result = await tool.handler({ tenant, limit: 1 }) as { cycles: unknown[] };
    expect(result.cycles).toHaveLength(1);
  });
});
