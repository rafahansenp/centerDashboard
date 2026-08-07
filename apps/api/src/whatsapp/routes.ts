import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { verifySignature } from './signature.js';
import { parseInboundMessages } from './parse.js';

const VerifyQuerySchema = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});

export async function registerWhatsAppRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Handshake feito uma única vez pela Meta ao cadastrar a URL. Precisa
  // devolver o challenge como texto puro.
  app.get('/webhooks/whatsapp', async (request, reply) => {
    const parsed = VerifyQuerySchema.safeParse(request.query);
    if (
      !parsed.success
      || parsed.data['hub.mode'] !== 'subscribe'
      || parsed.data['hub.verify_token'] !== deps.config.whatsapp.verifyToken
    ) {
      return reply.status(403).send('forbidden');
    }
    return reply.type('text/plain').send(parsed.data['hub.challenge']);
  });

  app.post('/webhooks/whatsapp', async (request, reply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const signature = request.headers['x-hub-signature-256'];

    if (!verifySignature(
      rawBody,
      typeof signature === 'string' ? signature : undefined,
      deps.config.whatsapp.appSecret,
    )) {
      request.log.warn('webhook do WhatsApp com assinatura inválida');
      return reply.status(401).send({ error: 'unauthorized' });
    }

    for (const message of parseInboundMessages(request.body)) {
      try {
        // Idempotência: a Meta reenvia o mesmo evento em caso de timeout.
        const seen = await deps.prisma.processedWebhookEvent.findUnique({
          where: { wamid: message.wamid },
        });
        if (seen) {
          request.log.info({ wamid: message.wamid }, 'evento duplicado ignorado');
          continue;
        }
        await deps.prisma.processedWebhookEvent.create({ data: { wamid: message.wamid } });
        await deps.queue.enqueue(message);
      } catch (error) {
        // Nunca devolvemos erro à Meta: 4xx/5xx gera reentrega em laço e, depois
        // de várias falhas, a Meta desativa o webhook.
        request.log.error({ err: error, wamid: message.wamid }, 'falha ao enfileirar mensagem');
      }
    }

    return reply.status(200).send({ received: true });
  });
}
