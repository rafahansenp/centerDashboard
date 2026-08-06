import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { GranularitySchema, IsoDateSchema, MetricSourceSchema, type MetricQuery, type MetricSource } from '@center/shared';
import { requireAuth } from '../auth/jwt.js';
import { resolveTenant } from '../tenant.js';
import type { AppDeps } from '../deps.js';

const MAX_RANGE_DAYS = 400;
const MAX_BATCH_SIZE = 12;

/**
 * Allowlist explícita de ferramentas expostas por HTTP.
 *
 * A rota genérica evita 19 rotas quase idênticas, mas sem esta trava um cliente
 * poderia invocar qualquer ferramenta registrada no MCP server — inclusive as
 * que venham a existir depois e não tenham sido pensadas para uso externo.
 */
export const ALLOWED_TOOLS: Record<MetricSource, readonly string[]> = {
  commerce: [
    'orders_by_status', 'failed_orders', 'payment_method_performance',
    'top_products', 'top_categories', 'compare_products',
    'campaign_revenue', 'channel_average_ticket', 'device_revenue',
    'campaign_conversion', 'campaign_returning_customers', 'out_of_stock_products',
  ],
  ga4: [
    'traffic_sources', 'campaign_users', 'device_performance', 'page_performance',
    'app_versions', 'top_events', 'compare_events', 'checkout_funnel',
  ],
  behavior: ['events_before_purchase', 'screen_abandon_impact'],
};

/** Ferramentas que listam registros voláteis não devem ser cacheadas. */
const UNCACHEABLE_TOOLS = new Set(['failed_orders', 'out_of_stock_products']);

/** Igual ao MetricQuerySchema, MENOS o tenant — que vem do JWT. */
const QueryBodySchema = z.object({
  metricId: z.string().min(1),
  from: IsoDateSchema,
  to: IsoDateSchema,
  granularity: GranularitySchema,
  filters: z.record(z.string(), z.string()).optional(),
  groupBy: z.string().optional(),
});
type QueryBody = z.infer<typeof QueryBodySchema>;

const BatchBodySchema = z.object({ queries: z.array(QueryBodySchema).min(1).max(MAX_BATCH_SIZE) });

class BadRequestError extends Error {}

function assertRange(body: { from: string; to: string }): void {
  if (body.from > body.to) {
    throw new BadRequestError(`"from" (${body.from}) é anterior a "to" (${body.to})`);
  }
  const spanDays =
    (Date.parse(`${body.to}T00:00:00Z`) - Date.parse(`${body.from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new BadRequestError(`intervalo excede o máximo de ${MAX_RANGE_DAYS} dias`);
  }
}

export function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: 'bad_request', message });
}

/** Falha de fonte externa é 502 (problema deles), não 500 (problema nosso). */
export function upstreamError(reply: FastifyReply, error: unknown) {
  return reply.status(502).send({
    error: 'upstream_error',
    message: error instanceof Error ? error.message : 'fonte de dados indisponível',
  });
}

export async function registerMetricRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/metrics/catalog', { preHandler: requireAuth }, async (_request, reply) => {
    try {
      return reply.send({ metrics: await deps.gateway.listMetrics() });
    } catch (error) {
      return upstreamError(reply, error);
    }
  });

  app.post('/api/metrics/query', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = QueryBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? 'corpo inválido');

    try {
      assertRange(parsed.data);
      const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
      const query: MetricQuery = { ...parsed.data, tenant };
      return reply.send(await deps.gateway.queryMetric(query));
    } catch (error) {
      if (error instanceof BadRequestError) return badRequest(reply, error.message);
      return upstreamError(reply, error);
    }
  });

  app.post('/api/metrics/batch', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = BatchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, `queries precisa ter entre 1 e ${MAX_BATCH_SIZE} itens`);
    }

    try {
      for (const item of parsed.data.queries) assertRange(item);
      const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
      const queries: MetricQuery[] = parsed.data.queries.map((item: QueryBody) => ({ ...item, tenant }));
      return reply.send({ series: await deps.gateway.queryBatch(queries) });
    } catch (error) {
      if (error instanceof BadRequestError) return badRequest(reply, error.message);
      return upstreamError(reply, error);
    }
  });

  app.post<{ Params: { source: string; name: string } }>(
    '/api/tools/:source/:name',
    { preHandler: requireAuth },
    async (request, reply) => {
      const source = MetricSourceSchema.safeParse(request.params.source);
      if (!source.success) {
        return reply.status(404).send({ error: 'not_found', message: 'fonte desconhecida' });
      }
      const name = request.params.name;
      if (!ALLOWED_TOOLS[source.data].includes(name)) {
        return reply.status(404).send({ error: 'not_found', message: `ferramenta não exposta: ${name}` });
      }

      try {
        const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (typeof body.from === 'string' && typeof body.to === 'string') {
          assertRange({ from: body.from, to: body.to });
        }
        // O tenant é escrito por último: sobrescreve qualquer valor forjado.
        const args = { ...body, tenant };
        return reply.send(await deps.gateway.callTool(source.data, name, args, {
          cache: !UNCACHEABLE_TOOLS.has(name),
          rangeEnd: typeof body.to === 'string' ? body.to : undefined,
        }));
      } catch (error) {
        if (error instanceof BadRequestError) return badRequest(reply, error.message);
        return upstreamError(reply, error);
      }
    },
  );
}
