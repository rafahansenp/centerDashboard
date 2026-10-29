import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps.js';
import { LINK_CODE_TTL_MINUTES, createLinkCode } from './linking.js';

export async function registerLinkRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/api/whatsapp/link-code',
    { preHandler: app.authenticate, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { code, expiresAt } = await createLinkCode(deps.prisma, request.auth.userId);
      return reply.send({
        code, expiresAt: expiresAt.toISOString(), ttlMinutes: LINK_CODE_TTL_MINUTES,
      });
    },
  );
}
