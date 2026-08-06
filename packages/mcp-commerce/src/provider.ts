import { Prisma, type PrismaClient } from '@prisma/client';
import type { MetricDescriptor, MetricQuery, MetricSeries, MetricUnit } from '@center/shared';
import { MetricNotFoundError, toSeries, type MetricProvider, type SeriesRow } from '@center/mcp-core';
import {
  REVENUE_STATUS_GROUPS, assertDimension, bucketExpression, rangeToUtc,
  ORDER_DIMENSION_NAMES,
} from './constants.js';

const DESCRIPTORS: MetricDescriptor[] = [
  {
    id: 'commerce.revenue', label: 'Faturamento',
    description: 'Receita dos pedidos com status de venda (pago, em separação, enviado, entregue), em centavos. Exclui cancelados, falhos e aguardando pagamento.',
    source: 'commerce', unit: 'currency', dimensions: ORDER_DIMENSION_NAMES,
  },
  {
    id: 'commerce.orders', label: 'Pedidos',
    description: 'Quantidade de pedidos com status de venda.',
    source: 'commerce', unit: 'count', dimensions: ORDER_DIMENSION_NAMES,
  },
  {
    id: 'commerce.average_ticket', label: 'Ticket médio',
    description: 'Faturamento dividido pela quantidade de pedidos no bucket, em centavos.',
    source: 'commerce', unit: 'currency', dimensions: ORDER_DIMENSION_NAMES,
  },
  {
    id: 'commerce.items_sold', label: 'Itens vendidos',
    description: 'Soma das quantidades dos itens dos pedidos com status de venda.',
    source: 'commerce', unit: 'count', dimensions: ORDER_DIMENSION_NAMES,
  },
  {
    id: 'commerce.new_customers', label: 'Clientes novos',
    description: 'Clientes cujo primeiro pedido caiu no período.',
    source: 'commerce', unit: 'count', dimensions: [],
  },
];

const UNITS: Record<string, MetricUnit> = {
  'commerce.revenue': 'currency',
  'commerce.orders': 'count',
  'commerce.average_ticket': 'currency',
  'commerce.items_sold': 'count',
  'commerce.new_customers': 'count',
};

function statusFilter(): Prisma.Sql {
  return Prisma.sql`o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)})`;
}

function dimensionFilters(query: MetricQuery): Prisma.Sql {
  const clauses = Object.entries(query.filters ?? {}).map(([name, value]) =>
    Prisma.sql`AND o.${Prisma.raw(`"${assertDimension(name)}"`)} = ${value}`);
  return clauses.length > 0 ? Prisma.join(clauses, ' ') : Prisma.empty;
}

function groupExpression(query: MetricQuery): Prisma.Sql {
  return query.groupBy
    ? Prisma.sql`o.${Prisma.raw(`"${assertDimension(query.groupBy)}"`)}`
    : Prisma.sql`NULL::text`;
}

interface RawRow { bucket: string; value: bigint | number | string; grp: string | null }

function toSeriesRows(rows: RawRow[]): SeriesRow[] {
  return rows.map((row) => ({
    date: row.bucket,
    value: Number(row.value),
    group: row.grp,
  }));
}

export function createCommerceProvider(prisma: PrismaClient): MetricProvider {
  return {
    descriptors: DESCRIPTORS,

    async query(query: MetricQuery): Promise<MetricSeries> {
      const unit = UNITS[query.metricId];
      if (!unit) throw new MetricNotFoundError(query.metricId);

      const { start, end } = rangeToUtc(query.from, query.to);
      const bucket = bucketExpression(query.granularity);
      const group = groupExpression(query);
      const filters = dimensionFilters(query);
      const orgId = query.tenant.organizationId;

      // Clientes novos não passam pela tabela de pedidos — a data relevante é
      // `firstOrderAt` do cliente, e agrupar por dimensão de pedido não faz sentido.
      if (query.metricId === 'commerce.new_customers') {
        // `firstOrderAt` também é naive-UTC — mesmo idioma de duas conversões
        // usado em `bucketExpression` (ver constants.ts).
        const customerBucket = Prisma.sql`to_char(date_trunc(${
          query.granularity === 'day' ? 'day' : query.granularity === 'week' ? 'week' : 'month'
        }, c."firstOrderAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD')`;

        const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
          SELECT ${customerBucket} AS bucket, COUNT(*)::bigint AS value, NULL::text AS grp
          FROM "CommerceCustomer" c
          WHERE c."organizationId" = ${orgId}
            AND c."firstOrderAt" >= ${start} AND c."firstOrderAt" < ${end}
          GROUP BY 1
        `);
        return toSeries(toSeriesRows(rows), query, unit, 'commerce');
      }

      if (query.metricId === 'commerce.items_sold') {
        // `emittedAt` (item) também é naive-UTC — mesmo idioma de duas
        // conversões usado em `bucketExpression` (ver constants.ts).
        const itemBucket = Prisma.sql`to_char(date_trunc(${
          query.granularity === 'day' ? 'day' : query.granularity === 'week' ? 'week' : 'month'
        }, i."emittedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD')`;

        const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
          SELECT ${itemBucket} AS bucket, SUM(i."quantity")::bigint AS value, ${group} AS grp
          FROM "CommerceOrderItem" i
          JOIN "CommerceOrder" o ON o."id" = i."orderId"
          WHERE i."organizationId" = ${orgId}
            AND i."emittedAt" >= ${start} AND i."emittedAt" < ${end}
            AND ${statusFilter()}
            ${filters}
          GROUP BY 1, 3
        `);
        return toSeries(toSeriesRows(rows), query, unit, 'commerce');
      }

      // O ticket médio é razão, não soma: precisa ser calculado POR BUCKET.
      // Somar médias diárias daria um número sem significado.
      const valueExpression =
        query.metricId === 'commerce.revenue'
          ? Prisma.sql`SUM(o."totalCents")::bigint`
          : query.metricId === 'commerce.orders'
            ? Prisma.sql`COUNT(*)::bigint`
            : Prisma.sql`ROUND(SUM(o."totalCents")::numeric / NULLIF(COUNT(*), 0))::bigint`;

      const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
        SELECT ${bucket} AS bucket, ${valueExpression} AS value, ${group} AS grp
        FROM "CommerceOrder" o
        WHERE o."organizationId" = ${orgId}
          AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
          AND ${statusFilter()}
          ${filters}
        GROUP BY 1, 3
      `);

      const series = toSeries(toSeriesRows(rows), query, unit, 'commerce');

      // O total de uma razão é a razão do período inteiro, não a soma dos buckets.
      if (query.metricId === 'commerce.average_ticket') {
        const [aggregate] = await prisma.$queryRaw<Array<{ revenue: bigint | null; orders: bigint }>>(Prisma.sql`
          SELECT SUM(o."totalCents")::bigint AS revenue, COUNT(*)::bigint AS orders
          FROM "CommerceOrder" o
          WHERE o."organizationId" = ${orgId}
            AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
            AND ${statusFilter()}
            ${filters}
        `);
        const orders = Number(aggregate?.orders ?? 0);
        return {
          ...series,
          total: orders === 0 ? 0 : Math.round(Number(aggregate?.revenue ?? 0) / orders),
        };
      }

      return series;
    },
  };
}
