import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GranularitySchema, IsoDateSchema } from '@center/shared';
import { correlateMetrics } from '@center/mcp-core';
import { requireAuth } from '../auth/jwt.js';
import { resolveTenant } from '../tenant.js';
import { analyzeAppVersionImpact } from '../analysis/app-version-impact.js';
import { badRequest, upstreamError, assertRange, BadRequestError } from './metrics.js';
import type { AppDeps } from '../deps.js';

const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

const CorrelateBodySchema = z.object({
  metricIdA: z.string().min(1),
  metricIdB: z.string().min(1),
  from: IsoDateSchema,
  to: IsoDateSchema,
  granularity: GranularitySchema,
});

const VersionImpactBodySchema = z.object({
  version: z.string().min(1),
  releaseDate: IsoDateSchema,
  windowDays: z.number().int().min(3).max(90).optional(),
});

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TIME_ZONE });
}

export async function registerAnalysisRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post('/api/analysis/correlate', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = CorrelateBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? 'corpo inválido');

    try {
      assertRange(parsed.data);
      const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
      return reply.send(await correlateMetrics(deps.gateway, { ...parsed.data, tenant }));
    } catch (error) {
      if (error instanceof BadRequestError) return badRequest(reply, error.message);
      // "métrica com ela mesma" é erro do cliente, não da fonte.
      if (error instanceof Error && error.message.includes('ela mesma')) {
        return badRequest(reply, error.message);
      }
      return upstreamError(reply, error);
    }
  });

  app.post('/api/analysis/app-version-impact', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = VersionImpactBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? 'corpo inválido');

    try {
      const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
      return reply.send(await analyzeAppVersionImpact({
        gateway: deps.gateway, tenant, today: today(), ...parsed.data,
      }));
    } catch (error) {
      if (error instanceof Error && error.message.includes('futuro')) {
        return badRequest(reply, error.message);
      }
      return upstreamError(reply, error);
    }
  });
}
