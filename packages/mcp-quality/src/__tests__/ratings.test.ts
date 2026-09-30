import { createRatingTrendTool } from '../ratings.js';
import { prisma, resetQualityData, seedSnapshots, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };
const period = { from: '2026-08-01', to: '2026-08-05', tenant };

beforeAll(async () => {
  await resetQualityData();
  await seedSnapshots([
    { platform: 'ANDROID', capturedAtLocal: '2026-08-01T03:00:00', averageRating: 4.20, ratingCount: 1000 },
    { platform: 'ANDROID', capturedAtLocal: '2026-08-02T03:00:00', averageRating: 4.25, ratingCount: 1010 },
    { platform: 'ANDROID', capturedAtLocal: '2026-08-03T03:00:00', averageRating: 4.30, ratingCount: 1020 },
    { platform: 'IOS', capturedAtLocal: '2026-08-01T03:00:00', averageRating: 4.60, ratingCount: 500 },
    // Fora da janela
    { platform: 'ANDROID', capturedAtLocal: '2026-09-01T03:00:00', averageRating: 4.90, ratingCount: 9999 },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

describe('rating_trend', () => {
  const tool = createRatingTrendTool(prisma);

  it('is named rating_trend', () => {
    expect(tool.name).toBe('rating_trend');
  });

  it('returns the most recent snapshot as current, and the one before it as previous', async () => {
    const result = await tool.handler({ ...period, platform: 'ANDROID' }) as {
      current: { averageRating: number } | null;
      previous: { averageRating: number } | null;
      points: unknown[];
    };
    expect(result.current?.averageRating).toBe(4.30);
    expect(result.previous?.averageRating).toBe(4.25);
    expect(result.points).toHaveLength(3);
  });

  it('never mixes platforms', async () => {
    const result = await tool.handler({ ...period, platform: 'IOS' }) as { current: { ratingCount: number } | null };
    expect(result.current?.ratingCount).toBe(500);
  });

  it('has no previous when only one snapshot exists in the period', async () => {
    const result = await tool.handler({ ...period, platform: 'IOS' }) as { previous: unknown };
    expect(result.previous).toBeNull();
  });
});
