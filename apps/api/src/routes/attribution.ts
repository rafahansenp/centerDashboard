import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';

const MAX_LANDING_PAGE = 512;

const TouchBodySchema = z.object({
  organizationId: z.string().min(1),
  clientId: z.string().min(1),
  source: z.string().max(120).optional(),
  medium: z.string().max(120).optional(),
  campaign: z.string().max(200).optional(),
  device: z.string().max(40).optional(),
  landingPage: z.string().optional(),
  email: z.string().email().optional(),
});

function normalizeTag(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export async function registerAttributionRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/public/attribution',
    {
      // Endpoint público: chamado do navegador do visitante, sem token.
      // O rate limit é a única defesa contra alguém poluir a atribuição.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = TouchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'bad_request', message: 'payload de atribuição inválido' });
      }
      const body = parsed.data;

      const organization = await deps.prisma.organization.findUnique({
        where: { id: body.organizationId },
        select: { id: true },
      });
      if (!organization) {
        return reply.status(404).send({ error: 'not_found', message: 'organização desconhecida' });
      }

      await deps.prisma.attributionTouch.create({
        data: {
          organizationId: organization.id,
          // Pseudonimização acontece aqui, antes de qualquer gravação.
          visitorHash: deps.pseudonymizer.hashVisitorId(body.clientId),
          emailHash: body.email ? deps.pseudonymizer.hashEmail(body.email) : null,
          source: normalizeTag(body.source),
          medium: normalizeTag(body.medium),
          campaign: normalizeTag(body.campaign),
          device: normalizeTag(body.device),
          landingPage: body.landingPage?.slice(0, MAX_LANDING_PAGE) ?? null,
        },
      });

      // 204 sem corpo: nada que volte daqui pode ajudar a identificar o visitante.
      return reply.status(204).send();
    },
  );
}
