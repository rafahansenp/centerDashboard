import { PrismaClient } from '@prisma/client';

export const TEST_ORG = 'org_test_quality';

export const prisma = new PrismaClient();

export async function resetQualityData(): Promise<void> {
  await prisma.appFeedback.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.appStoreSnapshot.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.organization.upsert({
    where: { id: TEST_ORG },
    update: {},
    create: { id: TEST_ORG, name: 'Org de Teste (Qualidade)' },
  });
}

export interface SeedSnapshot {
  platform: 'ANDROID' | 'IOS';
  capturedAtLocal: string;
  averageRating: number;
  ratingCount: number;
}

function toUtc(local: string): Date {
  return new Date(`${local}-03:00`);
}

export async function seedSnapshots(snapshots: SeedSnapshot[]): Promise<void> {
  await prisma.appStoreSnapshot.createMany({
    data: snapshots.map((s) => ({
      organizationId: TEST_ORG,
      platform: s.platform,
      capturedAt: toUtc(s.capturedAtLocal),
      averageRating: s.averageRating,
      ratingCount: s.ratingCount,
      rawPayload: {},
    })),
  });
}

export interface SeedFeedback {
  origin: 'STORE_ANDROID' | 'STORE_IOS' | 'MARKETPLACE';
  category: 'CRITICA' | 'ERRO' | 'SUGESTAO' | 'ELOGIO' | 'OUTRO';
  occurredAtLocal: string;
  rating?: number | null;
}

export async function seedFeedback(rows: SeedFeedback[]): Promise<void> {
  await prisma.appFeedback.createMany({
    data: rows.map((row) => ({
      organizationId: TEST_ORG,
      origin: row.origin,
      category: row.category,
      rating: row.rating ?? null,
      occurredAt: toUtc(row.occurredAtLocal),
      rawPayload: {},
    })),
  });
}
