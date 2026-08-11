import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { REVENUE_STATUS_GROUPS, rangeToUtc } from './constants.js';

const NO_CAMPAIGN = 'sem-campanha';

const PeriodShape = { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema };
const PeriodSchema = z.object(PeriodShape).extend({
  limit: z.number().int().min(1).max(50).default(10),
});

const RankingOutputShape = {
  dimension: z.string(), from: z.string(), to: z.string(),
  total: z.number(), unit: z.string(),
  rows: z.array(z.object({
    key: z.string(), label: z.string(), value: z.number(),
    unit: z.string(), extra: z.record(z.string(), z.number()), share: z.number(),
  })),
};

/**
 * Para rankings cujo valor por linha NÃO é aditivo (ticket médio, taxa de
 * recorrência…), somar as linhas e dividir cada uma pela soma produz um
 * `total`/`share` sem significado — ver achado B1 da revisão final de
 * branch. `total` aqui é sempre um agregado correto do período inteiro
 * (não a soma das linhas), calculado a partir dos mesmos contadores já
 * buscados; `share` é omitido porque "participação no total" não existe
 * para uma média ou uma taxa.
 */
const NonAdditiveRankingOutputShape = {
  dimension: z.string(), from: z.string(), to: z.string(),
  total: z.number(), unit: z.string(),
  rows: z.array(z.object({
    key: z.string(), label: z.string(), value: z.number(),
    unit: z.string(), extra: z.record(z.string(), z.number()), share: z.number().optional(),
  })),
};

interface DimensionRow {
  key: string | null;
  revenue: bigint | null;
  orders: bigint;
  customers: bigint;
  returning: bigint;
}

/**
 * Agrega pedidos com status de venda por uma coluna de atribuição.
 * `returning` conta clientes com mais de um pedido no período.
 */
function aggregateByColumn(
  prisma: PrismaClient,
  organizationId: string,
  start: Date,
  end: Date,
  column: string,
  fallback: string,
): Promise<DimensionRow[]> {
  return prisma.$queryRaw<DimensionRow[]>(Prisma.sql`
    WITH per_customer AS (
      SELECT COALESCE(o.${Prisma.raw(`"${column}"`)}, ${fallback}) AS key,
             o."customerId" AS customer_id,
             COUNT(*) AS customer_orders,
             SUM(o."totalCents") AS customer_revenue
      FROM "CommerceOrder" o
      WHERE o."organizationId" = ${organizationId}
        AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
        AND o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)})
      GROUP BY 1, 2
    )
    SELECT key,
           SUM(customer_revenue)::bigint AS revenue,
           SUM(customer_orders)::bigint AS orders,
           COUNT(*) FILTER (WHERE customer_id IS NOT NULL)::bigint AS customers,
           COUNT(*) FILTER (WHERE customer_id IS NOT NULL AND customer_orders > 1)::bigint AS returning
    FROM per_customer
    GROUP BY 1
  `);
}

interface RankingRowShape {
  key: string;
  label: string;
  value: number;
  unit: string;
  extra: Record<string, number>;
  share?: number;
}

type MappedDimensionRow = {
  key: string; revenue: number; orders: number; customers: number; returning: number;
  averageTicketCents: number;
};

interface BuildRowsOptions {
  /**
   * Falso quando o valor da linha não é aditivo entre grupos (ex.: ticket
   * médio, taxa de recorrência) — nesse caso `share` nunca é emitido e
   * `total` vem de `computeTotal`, nunca de somar as linhas.
   */
  additive: boolean;
  /**
   * Só usado quando `additive` é falso. Deriva um `total` correto a partir
   * dos contadores já buscados nesta mesma consulta (ex.: receita e pedidos
   * somados de todos os grupos, não só do top N). Nunca adivinha: se um
   * total correto não puder ser calculado sem uma consulta extra, o chamador
   * simplesmente não passa esta função e `total` fica de fora da resposta.
   */
  computeTotal?: (mapped: MappedDimensionRow[]) => number;
}

function buildRows(
  rows: DimensionRow[],
  pick: (row: { revenue: number; orders: number; customers: number; returning: number }) => number,
  unit: string,
  limit: number,
  options: BuildRowsOptions,
): { total?: number; rows: RankingRowShape[] } {
  const mapped: MappedDimensionRow[] = rows.map((row) => {
    const revenue = Number(row.revenue ?? 0);
    const orders = Number(row.orders);
    const customers = Number(row.customers);
    const returning = Number(row.returning);
    return {
      key: row.key ?? NO_CAMPAIGN,
      revenue, orders, customers, returning,
      averageTicketCents: orders === 0 ? 0 : Math.round(revenue / orders),
    };
  });

  const total = options.additive
    ? mapped.reduce((acc, row) => acc + pick(row), 0)
    : options.computeTotal?.(mapped);

  const ranked = [...mapped]
    .sort((a, b) => pick(b) - pick(a))
    .slice(0, limit)
    .map((row) => ({
      key: row.key,
      label: row.key,
      value: pick(row),
      unit,
      extra: {
        revenueCents: row.revenue,
        orders: row.orders,
        customers: row.customers,
        returningCustomers: row.returning,
        averageTicketCents: row.averageTicketCents,
      },
      ...(options.additive ? { share: total === 0 ? 0 : pick(row) / (total as number) } : {}),
    }));

  return { ...(total !== undefined ? { total } : {}), rows: ranked };
}

export function createCampaignRevenueTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'campaign_revenue',
    description:
      'Ranking de campanhas por faturamento no período, com pedidos e ticket médio. ' +
      'Usa a UTM capturada no checkout. Use para "qual campanha trouxe mais receita".',
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateByColumn(
        prisma, tenant.organizationId, start, end, 'attributionCampaign', NO_CAMPAIGN,
      );
      const built = buildRows(rows, (row) => row.revenue, 'currency', limit, { additive: true });
      return { dimension: 'campaign', from, to, unit: 'currency', ...built };
    },
  };
}

export function createChannelTicketTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'channel_average_ticket',
    description:
      'Ticket médio por canal de venda (site, app, marketplace…) no período. ' +
      'Use para "quais canais possuem maior ticket médio". `total` é o ticket ' +
      'médio geral do período inteiro (receita total / pedidos totais), não a ' +
      'soma dos tickets médios de cada canal. `share` não é reportado por linha: ' +
      'ticket médio não é aditivo entre canais, então "participação no total" ' +
      'não tem significado aqui.',
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: NonAdditiveRankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateByColumn(
        prisma, tenant.organizationId, start, end, 'canal', 'sem-canal',
      );
      // Ordenado por ticket médio, não por receita — é o que a pergunta pede.
      const built = buildRows(rows, (row) => (row.orders === 0 ? 0 : Math.round(row.revenue / row.orders)), 'currency', limit, {
        additive: false,
        // Ticket médio geral do período: receita total / pedidos totais de
        // TODOS os canais (não só do top N exibido) — dados já buscados
        // nesta mesma consulta, nenhuma chamada extra.
        computeTotal: (mapped) => {
          const revenue = mapped.reduce((acc, row) => acc + row.revenue, 0);
          const orders = mapped.reduce((acc, row) => acc + row.orders, 0);
          return orders === 0 ? 0 : Math.round(revenue / orders);
        },
      });
      return { dimension: 'channel', from, to, unit: 'currency', ...built };
    },
  };
}

export function createDeviceRevenueTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'device_revenue',
    description:
      'Faturamento e ticket médio por dispositivo (mobile, desktop, tablet) no período. ' +
      'Use para "quais dispositivos geram maior receita".',
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateByColumn(
        prisma, tenant.organizationId, start, end, 'attributionDevice', 'desconhecido',
      );
      const built = buildRows(rows, (row) => row.revenue, 'currency', limit, { additive: true });
      return { dimension: 'device', from, to, unit: 'currency', ...built };
    },
  };
}

export function createCampaignConversionTool(prisma: PrismaClient): AnalysisTool {
  const InputSchema = z.object({ ...PeriodShape, campaign: z.string().min(1) });

  return {
    name: 'campaign_conversion',
    description:
      'Quantos visitantes que chegaram por uma campanha acabaram comprando, e quanto ' +
      'gastaram. Use para "usuários que clicaram na campanha compraram?". O cruzamento é ' +
      'feito por identificador pseudonimizado — nenhum dado pessoal é exposto.',
    inputSchema: { ...PeriodShape, campaign: z.string() },
    outputSchema: {
      campaign: z.string(), from: z.string(), to: z.string(),
      visitors: z.number(), buyers: z.number(),
      conversionRate: z.number(), revenueCents: z.number(), averageTicketCents: z.number(),
    },
    handler: async (args) => {
      const { from, to, tenant, campaign } = InputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const normalized = campaign.trim().toLowerCase();

      // O join acontece pelo visitorHash — HMAC do client_id do GA4, gravado
      // pelas duas pontas (toque e pedido). Nunca há client_id em claro aqui.
      const [row] = await prisma.$queryRaw<Array<{
        visitors: bigint; buyers: bigint; revenue: bigint | null; orders: bigint;
      }>>(Prisma.sql`
        WITH touched AS (
          SELECT DISTINCT t."visitorHash"
          FROM "AttributionTouch" t
          WHERE t."organizationId" = ${tenant.organizationId}
            AND t."campaign" = ${normalized}
            AND t."occurredAt" >= ${start} AND t."occurredAt" < ${end}
        ),
        purchases AS (
          SELECT o."visitorHash", SUM(o."totalCents") AS revenue, COUNT(*) AS orders
          FROM "CommerceOrder" o
          JOIN touched ON touched."visitorHash" = o."visitorHash"
          WHERE o."organizationId" = ${tenant.organizationId}
            AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
            AND o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)})
          GROUP BY 1
        )
        SELECT (SELECT COUNT(*) FROM touched)::bigint AS visitors,
               (SELECT COUNT(*) FROM purchases)::bigint AS buyers,
               (SELECT SUM(revenue) FROM purchases)::bigint AS revenue,
               (SELECT SUM(orders) FROM purchases)::bigint AS orders
      `);

      const visitors = Number(row?.visitors ?? 0);
      const buyers = Number(row?.buyers ?? 0);
      const revenueCents = Number(row?.revenue ?? 0);
      const orders = Number(row?.orders ?? 0);

      return {
        campaign: normalized, from, to,
        visitors, buyers,
        conversionRate: visitors === 0 ? 0 : buyers / visitors,
        revenueCents,
        averageTicketCents: orders === 0 ? 0 : Math.round(revenueCents / orders),
      };
    },
  };
}

export function createReturningCustomersTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'campaign_returning_customers',
    description:
      'Proporção de clientes que compraram mais de uma vez, por campanha. Use para ' +
      '"quais campanhas geraram usuários recorrentes". O valor de cada linha é a taxa ' +
      'de recorrência da campanha (0 a 1). `total` é a taxa de recorrência geral do ' +
      'período (clientes recorrentes / clientes totais, de todas as campanhas), não a ' +
      'soma das taxas de cada linha. `share` não é reportado por linha: taxa não é ' +
      'aditiva entre campanhas.',
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: NonAdditiveRankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateByColumn(
        prisma, tenant.organizationId, start, end, 'attributionCampaign', NO_CAMPAIGN,
      );
      const built = buildRows(
        rows,
        (row) => (row.customers === 0 ? 0 : row.returning / row.customers),
        'ratio',
        limit,
        {
          additive: false,
          // Taxa de recorrência geral do período: clientes recorrentes / clientes
          // totais somados de TODAS as campanhas (não só do top N exibido).
          computeTotal: (mapped) => {
            const customers = mapped.reduce((acc, row) => acc + row.customers, 0);
            const returning = mapped.reduce((acc, row) => acc + row.returning, 0);
            return customers === 0 ? 0 : returning / customers;
          },
        },
      );
      return { dimension: 'campaign', from, to, unit: 'ratio', ...built };
    },
  };
}
