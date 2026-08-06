import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type { AppDeps } from './deps.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerMetricRoutes } from './routes/metrics.js';
import { registerAnalysisRoutes } from './routes/analysis.js';
// As rotas abaixo nascem em tasks futuras. Descomente o import e a chamada de
// registro correspondente conforme cada task chega.
// TODO(T9):  import { registerAttributionRoutes } from './routes/attribution.js';
// TODO(T32): import { registerWhatsAppRoutes } from './whatsapp/routes.js';
// TODO(T34): import { registerLinkRoutes } from './whatsapp/link-routes.js';

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  // `trustProxy` faz `request.ip` refletir `x-forwarded-for` em vez do
  // socket cru. Sem isso, atrás de qualquer load balancer/ingress em
  // produção, o rate limit do login (chave = request.ip) colapsa TODOS os
  // clientes num único balde — um atacante zera as tentativas de qualquer
  // usuário legítimo.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

  // O corpo cru é necessário para validar a assinatura do webhook do WhatsApp
  // (T32). Guardamos aqui, no único ponto onde o buffer ainda existe.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    (request as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(Object.assign(new Error('JSON inválido'), { statusCode: 400 }), undefined);
    }
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: deps.config.jwtSecret });
  await app.register(rateLimit, {
    global: true, max: 300, timeWindow: '1 minute',
    allowList: (request) => request.url === '/health',
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await registerAuthRoutes(app, deps);
  await registerMetricRoutes(app, deps);
  await registerAnalysisRoutes(app, deps);
  // TODO(T9):  await registerAttributionRoutes(app, deps);
  // TODO(T32): await registerWhatsAppRoutes(app, deps);
  // TODO(T34): await registerLinkRoutes(app, deps);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'erro não tratado');
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? 'internal_error' : 'bad_request',
      // Nunca vaza mensagem de erro interno para o cliente.
      message: statusCode >= 500 ? 'erro interno' : error.message,
    });
  });

  return app;
}
