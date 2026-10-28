import { createFeedbackByCategoryTool } from '../feedback.js';
import { prisma, resetQualityData, seedFeedback, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };
const period = { from: '2026-08-01', to: '2026-08-05', tenant };

beforeAll(async () => {
  await resetQualityData();
  await seedFeedback([
    { origin: 'STORE_ANDROID', category: 'ELOGIO', occurredAtLocal: '2026-08-01T10:00:00' },
    { origin: 'STORE_ANDROID', category: 'ELOGIO', occurredAtLocal: '2026-08-02T10:00:00' },
    { origin: 'STORE_IOS', category: 'ERRO', occurredAtLocal: '2026-08-02T10:00:00' },
    { origin: 'MARKETPLACE', category: 'OUTRO', occurredAtLocal: '2026-08-03T10:00:00' },
    // Fora da janela
    { origin: 'STORE_ANDROID', category: 'CRITICA', occurredAtLocal: '2026-09-10T10:00:00' },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

describe('feedback_by_category', () => {
  const tool = createFeedbackByCategoryTool(prisma);

  it('is named feedback_by_category', () => {
    expect(tool.name).toBe('feedback_by_category');
  });

  it('counts feedback per category, sorted by count descending', async () => {
    const result = await tool.handler(period) as { total: number; rows: Array<{ key: string; value: number }> };
    expect(result.total).toBe(4);
    expect(result.rows[0]).toMatchObject({ key: 'ELOGIO', value: 2 });
  });

  it('shares always sum to 1', async () => {
    const result = await tool.handler(period) as { rows: Array<{ share: number }> };
    const sum = result.rows.reduce((acc, row) => acc + row.share, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('filters by origin when provided', async () => {
    const result = await tool.handler({ ...period, origin: 'MARKETPLACE' }) as { total: number };
    expect(result.total).toBe(1);
  });
});
