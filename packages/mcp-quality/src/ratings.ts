import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { rangeToUtc } from './constants.js';

const PlatformSchema = z.enum(['ANDROID', 'IOS']);

const InputSchema = z.object({
  from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema,
  platform: PlatformSchema,
});

/**
 * Tendência da nota da loja (Play Console / App Store Connect) por
 * plataforma. `current`/`previous` vêm do snapshot mais recente e do
 * anterior — nunca de uma média sobre o período, que esconderia a nota atual
 * atrás de dias antigos.
 */
export function createRatingTrendTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'rating_trend',
    description:
      'Tendência da nota média da loja (Android ou iOS) no período, com a nota atual e a ' +
      'variação em relação ao snapshot anterior. Use para "a nota da loja caiu depois da ' +
      'última atualização".',
    inputSchema: { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema, platform: PlatformSchema },
    outputSchema: {
      platform: z.string(), from: z.string(), to: z.string(),
      points: z.array(z.object({ date: z.string(), averageRating: z.number(), ratingCount: z.number() })),
      current: z.object({ averageRating: z.number(), ratingCount: z.number(), capturedAt: z.string() }).nullable(),
      previous: z.object({ averageRating: z.number(), capturedAt: z.string() }).nullable(),
    },
    handler: async (args) => {
      const { from, to, tenant, platform } = InputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      const snapshots = await prisma.appStoreSnapshot.findMany({
        where: { organizationId: tenant.organizationId, platform, capturedAt: { gte: start, lt: end } },
        orderBy: { capturedAt: 'asc' },
        select: { capturedAt: true, averageRating: true, ratingCount: true },
      });

      const current = snapshots[snapshots.length - 1] ?? null;
      const previous = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;

      return {
        platform, from, to,
        points: snapshots.map((s) => ({
          date: s.capturedAt.toISOString().slice(0, 10),
          averageRating: s.averageRating,
          ratingCount: s.ratingCount,
        })),
        current: current
          ? { averageRating: current.averageRating, ratingCount: current.ratingCount, capturedAt: current.capturedAt.toISOString().slice(0, 10) }
          : null,
        previous: previous
          ? { averageRating: previous.averageRating, capturedAt: previous.capturedAt.toISOString().slice(0, 10) }
          : null,
      };
    },
  };
}
