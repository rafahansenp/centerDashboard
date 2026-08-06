import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type { AppDeps } from './deps.js';
import { registerAuthRoutes } from './auth/routes.js';
// As rotas abaixo nascem em tasks futuras. Descomente o import e a chamada de
// registro correspondente conforme cada task chega — o servidor desta task
// (T22) só depende de `registerAuthRoutes`.
// TODO(T23): import { registerMetricRoutes } from './routes/metrics.js';
// TODO(T23): import { registerAnalysisRoutes } from './routes/analysis.js';
// TODO(T9):  import { registerAttributionRoutes } from './routes/attribution.js';
// TODO(T32): import { registerWhatsAppRoutes } from './whatsapp/routes.js';
// TODO(T34): import { registerLinkRoutes } from './whatsapp/link-routes.js';

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

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
  // TODO(T23): await registerMetricRoutes(app, deps);
  // TODO(T23): await registerAnalysisRoutes(app, deps);
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
