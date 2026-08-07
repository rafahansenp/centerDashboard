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
      // `create` antes de `enqueue` (nunca o contrário): é essa ordem que
      // resolve a corrida de duas entregas simultâneas do mesmo wamid — a
      // que perde o `create` recebe uma violação de unique constraint
      // (wamid é @id), cai no catch abaixo e nunca chega a enfileirar de
      // novo. Inverter a ordem reabriria essa corrida.
      let marked = false;
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
        marked = true;
        await deps.queue.enqueue(message);
      } catch (error) {
        // Nunca devolvemos erro à Meta: 4xx/5xx gera reentrega em laço e, depois
        // de várias falhas, a Meta desativa o webhook.
        request.log.error({ err: error, wamid: message.wamid }, 'falha ao enfileirar mensagem');

        if (marked) {
          // O evento já tinha sido marcado como processado quando o
          // enfileiramento falhou — sem desfazer isso, a Meta veria 200 e
          // nunca reentregaria, perdendo a mensagem para sempre. Reverte a
          // marca para que uma reentrega futura do mesmo wamid tente
          // enfileirar de novo.
          try {
            await deps.prisma.processedWebhookEvent.delete({ where: { wamid: message.wamid } });
          } catch (deleteError) {
            request.log.error(
              { err: deleteError, wamid: message.wamid },
              'falha ao reverter registro de evento processado após falha no enfileiramento',
            );
          }
        }
      }
    }

    return reply.status(200).send({ received: true });
  });
}
