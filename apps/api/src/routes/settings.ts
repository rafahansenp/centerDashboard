import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth/jwt.js';
import type { AppDeps } from '../deps.js';

const UpdateBodySchema = z.object({
  uappiApiKey: z.string().min(1).optional(),
  uappiSecretKey: z.string().min(1).optional(),
  ga4PropertyId: z.string().min(1).optional(),
  ga4BigQueryDataset: z.string().min(1).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: 'informe ao menos um campo' });

interface IntegrationsView {
  uappi: { configured: boolean };
  ga4: { propertyId: string | null; bigQueryDataset: string | null };
}

function toView(org: {
  uappiApiKey: string | null; uappiSecretKey: string | null;
  ga4PropertyId: string | null; ga4BigQueryDataset: string | null;
}): IntegrationsView {
  return {
    // As duas credenciais são configuradas juntas ou não — reportamos "true"
    // só quando ambas existem, para não sugerir que a integração funciona
    // com metade das credenciais.
    uappi: { configured: Boolean(org.uappiApiKey && org.uappiSecretKey) },
    ga4: { propertyId: org.ga4PropertyId, bigQueryDataset: org.ga4BigQueryDataset },
  };
}

export async function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/settings/integrations', { preHandler: requireAuth }, async (request, reply) => {
    const org = await deps.prisma.organization.findUnique({
      where: { id: request.auth.organizationId },
      select: { uappiApiKey: true, uappiSecretKey: true, ga4PropertyId: true, ga4BigQueryDataset: true },
    });
    if (!org) return reply.status(404).send({ error: 'not_found', message: 'organização não encontrada' });
    return reply.send(toView(org));
  });

  app.put(
    '/api/settings/integrations',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const parsed = UpdateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'bad_request', message: parsed.error.issues[0]?.message ?? 'corpo inválido' });
      }
      const body = parsed.data;

      const data: Record<string, string> = {};
      // Cifra na borda — a partir daqui, o valor em claro não existe mais em
      // nenhuma variável deste processo.
      if (body.uappiApiKey) data.uappiApiKey = deps.secretBox.encrypt(body.uappiApiKey);
      if (body.uappiSecretKey) data.uappiSecretKey = deps.secretBox.encrypt(body.uappiSecretKey);
      if (body.ga4PropertyId) data.ga4PropertyId = body.ga4PropertyId;
      if (body.ga4BigQueryDataset) data.ga4BigQueryDataset = body.ga4BigQueryDataset;

      const updated = await deps.prisma.organization.update({
        where: { id: request.auth.organizationId },
        data,
        select: { uappiApiKey: true, uappiSecretKey: true, ga4PropertyId: true, ga4BigQueryDataset: true },
      });

      return reply.send(toView(updated));
    },
  );
}
