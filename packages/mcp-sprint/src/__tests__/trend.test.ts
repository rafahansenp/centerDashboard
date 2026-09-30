import { createSprintTypeTrendTool } from '../trend.js';
import { prisma, resetSprintData, seedTasks, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };
const period = { from: '2026-07-01', to: '2026-08-31', tenant };

beforeAll(async () => {
  await resetSprintData();
  await seedTasks([
    { externalId: 't1', title: 'A', area: 'FRONT', type: 'MODULO', status: 'ENTREGUE', createdAtLocal: '2026-07-05T10:00:00' },
    { externalId: 't2', title: 'B', area: 'FRONT', type: 'MODULO', status: 'ENTREGUE', createdAtLocal: '2026-07-20T10:00:00' },
    { externalId: 't3', title: 'C', area: 'BACK', type: 'BUGFIX', status: 'ENTREGUE', createdAtLocal: '2026-08-02T10:00:00' },
    // Fora da janela
    { externalId: 't4', title: 'D', area: 'BACK', type: 'MODULO', status: 'ENTREGUE', createdAtLocal: '2026-06-01T10:00:00' },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

describe('sprint_type_trend', () => {
  const tool = createSprintTypeTrendTool(prisma);

  it('is named sprint_type_trend', () => {
    expect(tool.name).toBe('sprint_type_trend');
  });

  it('groups counts by month and type, using the chart labels (not the task-table labels)', async () => {
    const result = await tool.handler(period) as {
      points: Array<{ month: string; type: string; label: string; count: number }>;
    };
    expect(result.points).toContainEqual({ month: '2026-07', type: 'MODULO', label: 'Tasks', count: 2 });
    expect(result.points).toContainEqual({ month: '2026-08', type: 'BUGFIX', label: 'Análises', count: 1 });
  });

  it('excludes tasks outside the period', async () => {
    const result = await tool.handler(period) as { points: Array<{ month: string }> };
    expect(result.points.some((p) => p.month === '2026-06')).toBe(false);
  });
});
