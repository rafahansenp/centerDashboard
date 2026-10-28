import { createSprintSummaryTool } from '../summary.js';
import { prisma, resetSprintData, seedTasks, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };
const period = { from: '2026-08-01', to: '2026-08-31', tenant };

beforeAll(async () => {
  await resetSprintData();
  await seedTasks([
    { externalId: 't1', title: 'A', area: 'FRONT', type: 'MODULO', status: 'ENTREGUE', sprintNumber: 1, createdAtLocal: '2026-08-01T10:00:00' },
    { externalId: 't2', title: 'B', area: 'BACK', type: 'BUGFIX', status: 'ENTREGUE', sprintNumber: 1, createdAtLocal: '2026-08-02T10:00:00' },
    { externalId: 't3', title: 'C', area: 'FRONT', type: 'BUGFIX', status: 'PLANEJADO', sprintNumber: 2, createdAtLocal: '2026-08-10T10:00:00' },
    { externalId: 't4', title: 'D', area: 'BACK', type: 'MELHORIA', status: 'ADICIONAL', sprintNumber: 2, createdAtLocal: '2026-08-11T10:00:00' },
    // Fora da janela
    { externalId: 't5', title: 'E', area: 'FRONT', type: 'CORRECAO', status: 'ENTREGUE', createdAtLocal: '2026-07-01T10:00:00' },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

describe('sprint_summary', () => {
  const tool = createSprintSummaryTool(prisma);

  it('is named sprint_summary', () => {
    expect(tool.name).toBe('sprint_summary');
  });

  it('totals only tasks created inside the period', async () => {
    const result = await tool.handler(period) as { total: number };
    expect(result.total).toBe(4);
  });

  it('groups by status, type and area', async () => {
    const result = await tool.handler(period) as {
      byStatus: Array<{ key: string; count: number }>;
      byType: Array<{ key: string; count: number }>;
      byArea: Array<{ key: string; count: number }>;
    };
    expect(result.byStatus.find((r) => r.key === 'ENTREGUE')?.count).toBe(2);
    expect(result.byType.find((r) => r.key === 'BUGFIX')?.count).toBe(2);
    expect(result.byArea.find((r) => r.key === 'FRONT')?.count).toBe(2);
  });

  it('filters by sprintNumber when provided', async () => {
    const result = await tool.handler({ ...period, sprintNumber: 2 }) as { total: number };
    expect(result.total).toBe(2);
  });
});
