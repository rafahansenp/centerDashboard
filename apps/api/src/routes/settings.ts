import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireAuth } from '../auth/jwt.js';
import type { AppDeps } from '../deps.js';

/**
 * Painel de integrações: só leitura de STATUS. Nenhum campo de config nem de
 * segredo sai daqui — a configuração é feita pelo backoffice.
 */
export async function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get(
    '/api/settings/integrations',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const organizationId = request.auth.organizationId;
      const rows = await deps.prisma.integration.findMany({
        where: { organizationId },
        select: { kind: true, provider: true, status: true },
        orderBy: { kind: 'asc' },
      });

      const commerceSync = rows.some((row) => row.kind === 'COMMERCE')
        ? await deps.prisma.syncState.findUnique({
            where: { organizationId_resource: { organizationId, resource: 'orders' } },
            select: { lastSyncedAt: true },
          })
        : null;

      return reply.send({
        integrations: rows.map((row) => ({
          kind: row.kind,
          provider: row.provider,
          status: row.status,
          lastSyncedAt: row.kind === 'COMMERCE' ? (commerceSync?.lastSyncedAt?.toISOString() ?? null) : null,
        })),
      });
    },
  );
}
