import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { AppDeps } from './deps.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerMetricRoutes } from './routes/metrics.js';
import { registerAnalysisRoutes } from './routes/analysis.js';
import { registerAttributionRoutes } from './routes/attribution.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerWhatsAppRoutes } from './whatsapp/routes.js';
import { registerLinkRoutes } from './whatsapp/link-routes.js';

// No runtime empacotado, este arquivo compila para apps/api/dist/server.js;
// dois níveis acima (apps/api/dist -> apps/api -> apps/) e então para
// web/dist chega em apps/web/dist — o build do Vite (T25) que o Dockerfile
// (T39) já produz no mesmo estágio que compila esta pasta, copiado inteiro
// para a imagem de runtime. Sobrescrito nos testes via `opts.webRoot`.
const DEFAULT_WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

// Prefixos que NUNCA devem cair no fallback de SPA nem seriam,
// coincidentemente, um arquivo estático de verdade: se uma rota real sob um
// desses prefixos não bater em nenhum handler registrado, o cliente precisa
// ver um 404 de API (JSON), não a index.html do dashboard.
//
// Sem barra final de propósito (ex.: '/api', não '/api/'), e comparado em
// minúsculas: o roteador do Fastify (find-my-way) é sensível a maiúsculas e
// não faz normalização de prefixo, então `GET /api` (sem nada depois), `GET
// /apifoo` (prefixo "colado", sem barra) e `GET /API/metrics/catalog` (case
// diferente) nunca batem em nenhuma rota registrada — mas TÊM cara de rota de
// API. Cair no fallback de SPA nesses casos devolveria 200 + HTML do
// dashboard para um cliente de API, exatamente o "mascarar erro de API como
// HTML" que este fallback existe para evitar. Nenhuma rota real do
// react-router (ver apps/web/src/App.tsx: '/', '/login', '/produtos',
// '/aquisicao', '/configuracoes') começa com um destes prefixos, então este
// matching mais amplo não engole rota nenhuma do dashboard.
const RESERVED_PREFIXES = ['/api', '/auth', '/public', '/webhooks'];
const RESERVED_EXACT = new Set(['/health']);

function isReservedPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return RESERVED_EXACT.has(lower) || RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export async function buildServer(deps: AppDeps, opts: { webRoot?: string } = {}): Promise<FastifyInstance> {
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
    // O webhook do WhatsApp tem a assinatura HMAC como sua ÚNICA fronteira de
    // segurança (ver whatsapp/signature.ts) — não pode também ficar sujeito a
    // um limitador cuja chave (request.ip, via trustProxy) é o header
    // X-Forwarded-For, trivialmente forjável. Sem este allowList, um
    // atacante forjando o IP de entrega da Meta consegue esgotar o balde e
    // derrubar a entrega legítima de mensagens (a Meta desativa o webhook
    // após falhas repetidas).
    allowList: (request) => request.url === '/health' || request.url.startsWith('/webhooks/whatsapp'),
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await registerAuthRoutes(app, deps);
  await registerMetricRoutes(app, deps);
  await registerAnalysisRoutes(app, deps);
  await registerAttributionRoutes(app, deps);
  await registerSettingsRoutes(app, deps);
  await registerAgentRoutes(app, deps);
  // Desativado a pedido do usuário (2026-09-30): o webhook público
  // `/webhooks/whatsapp` exige que a Meta alcance este servidor pela
  // internet — enquanto não há decisão de expor isso, a integração fica
  // fora do ar. Reative descomentando esta linha quando for usar o bot.
  // await registerWhatsAppRoutes(app, deps);
  await registerLinkRoutes(app, deps);

  // Serve o dashboard React (apps/web/dist) na mesma origem que a API — é o
  // que `apps/web/src/lib/api-client.ts` já assume (paths relativos, sem
  // base URL), e mantém `/center-attribution.js` (docs/checkout-attribution.md)
  // alcançável sem um segundo serviço/reverse proxy. `wildcard: false` evita
  // que o plugin registre a própria rota coringa GET '/*' — o fallback de SPA
  // abaixo, via setNotFoundHandler, decide isso à mão para poder distinguir
  // "arquivo do dashboard não encontrado" (serve index.html) de "rota de API
  // não encontrada" (404 JSON), o que uma rota coringa genérica não sabe fazer.
  await app.register(fastifyStatic, {
    root: opts.webRoot ?? DEFAULT_WEB_ROOT,
    wildcard: false,
  });

  // Rotas específicas (GET /api/..., /auth/me, etc.) SEMPRE vencem uma rota
  // coringa no roteador do Fastify (find-my-way), não importa a ordem de
  // registro — então este fallback só é alcançado quando NENHUM handler
  // específico bateu. Ainda assim, distinguimos por prefixo: uma rota de API
  // desconhecida deve devolver 404 JSON (o cliente sabe tratar isso), nunca a
  // index.html do dashboard — só GET fora de /api, /auth, /public, /webhooks
  // e /health cai no fallback de histórico do SPA (deep link em rota do
  // react-router, ex.: /produtos).
  app.setNotFoundHandler(async (request, reply) => {
    const pathname = request.url.split('?')[0] ?? request.url;
    if (request.method === 'GET' && !isReservedPath(pathname)) {
      // `send` (usado por sendFile) já infere `text/html` pela extensão do
      // arquivo — nenhum content-type manual necessário aqui.
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: 'not_found', message: 'rota não encontrada' });
  });

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
