import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { REVENUE_STATUS_GROUPS, rangeToUtc } from './constants.js';

const NO_CATEGORY = 'Sem categoria';

const RankingInputSchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  tenant: TenantContextSchema,
  limit: z.number().int().min(1).max(50).default(10),
  orderBy: z.enum(['revenue', 'quantity']).default('revenue'),
});

const RankingInputShape = {
  from: IsoDateSchema,
  to: IsoDateSchema,
  tenant: TenantContextSchema,
  limit: z.number().optional(),
  orderBy: z.enum(['revenue', 'quantity']).optional(),
};

const RankingOutputShape = {
  dimension: z.string(), from: z.string(), to: z.string(),
  total: z.number(), unit: z.string(),
  rows: z.array(z.object({
    key: z.string(), label: z.string(), value: z.number(),
    unit: z.string(), extra: z.record(z.string(), z.number()), share: z.number(),
  })),
};

interface AggregateRow {
  key: string | null;
  label: string | null;
  revenue: bigint | null;
  quantity: bigint | null;
  orders: bigint;
}

/** Agrega itens vendidos por SKU ou por categoria no período. */
function aggregateItems(
  prisma: PrismaClient,
  organizationId: string,
  start: Date,
  end: Date,
  by: 'sku' | 'category',
): Promise<AggregateRow[]> {
  const keyExpression = by === 'sku'
    ? Prisma.sql`i."sku"`
    : Prisma.sql`COALESCE(i."categoryName", ${NO_CATEGORY})`;
  const labelExpression = by === 'sku'
    ? Prisma.sql`MIN(i."productName")`
    : Prisma.sql`COALESCE(i."categoryName", ${NO_CATEGORY})`;
  // Para 'sku' o label é um agregado (MIN) e não pode entrar no GROUP BY.
  // Para 'category' o label repete a expressão da chave, mas o Postgres
  // trata cada interpolação de ${NO_CATEGORY} como um parâmetro distinto —
  // duas ocorrências do "mesmo" COALESCE não são reconhecidas como a mesma
  // expressão de agrupamento, então a posição 2 precisa ser listada também.
  const groupByClause = by === 'sku' ? Prisma.sql`GROUP BY 1` : Prisma.sql`GROUP BY 1, 2`;

  return prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT ${keyExpression} AS key,
           ${labelExpression} AS label,
           SUM(i."totalPriceCents")::bigint AS revenue,
           SUM(i."quantity")::bigint AS quantity,
           COUNT(DISTINCT i."orderId")::bigint AS orders
    FROM "CommerceOrderItem" i
    JOIN "CommerceOrder" o ON o."id" = i."orderId"
    WHERE i."organizationId" = ${organizationId}
      AND i."emittedAt" >= ${start} AND i."emittedAt" < ${end}
      AND o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)})
    ${groupByClause}
  `);
}

function buildRanking(
  rows: AggregateRow[],
  orderBy: 'revenue' | 'quantity',
  limit: number,
  dimension: string,
  from: string,
  to: string,
) {
  const unit = orderBy === 'revenue' ? 'currency' : 'count';

  const mapped = rows.map((row) => ({
    key: row.key ?? NO_CATEGORY,
    label: row.label ?? row.key ?? NO_CATEGORY,
    revenue: Number(row.revenue ?? 0),
    quantity: Number(row.quantity ?? 0),
    orders: Number(row.orders),
  }));

  const total = mapped.reduce((acc, row) => acc + (orderBy === 'revenue' ? row.revenue : row.quantity), 0);

  const ranked = [...mapped]
    .sort((a, b) => (orderBy === 'revenue' ? b.revenue - a.revenue : b.quantity - a.quantity))
    .slice(0, limit)
    .map((row) => {
      const value = orderBy === 'revenue' ? row.revenue : row.quantity;
      return {
        key: row.key,
        label: row.label,
        value,
        unit,
        extra: { revenueCents: row.revenue, quantity: row.quantity, orders: row.orders },
        // O share usa o total do PERÍODO, não o dos itens exibidos — senão
        // limitar a 10 faria as fatias somarem 100% indevidamente.
        share: total === 0 ? 0 : value / total,
      };
    });

  return { dimension, from, to, total, unit, rows: ranked };
}

export function createTopProductsTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'top_products',
    description:
      'Ranking de produtos mais vendidos no período, por faturamento (padrão) ou por ' +
      'quantidade. Considera apenas pedidos com status de venda. Valores em centavos.',
    inputSchema: RankingInputShape,
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit, orderBy } = RankingInputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateItems(prisma, tenant.organizationId, start, end, 'sku');
      return buildRanking(rows, orderBy, limit, 'product', from, to);
    },
  };
}

export function createTopCategoriesTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'top_categories',
    description:
      'Ranking de categorias mais vendidas no período, por faturamento (padrão) ou por ' +
      'quantidade. Itens sem categoria aparecem agrupados como "Sem categoria".',
    inputSchema: RankingInputShape,
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit, orderBy } = RankingInputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateItems(prisma, tenant.organizationId, start, end, 'category');
      return buildRanking(rows, orderBy, limit, 'category', from, to);
    },
  };
}

export function createCompareProductsTool(prisma: PrismaClient): AnalysisTool {
  const InputSchema = z.object({
    tenant: TenantContextSchema,
    periodA: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
    periodB: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
    limit: z.number().int().min(1).max(50).default(10),
    orderBy: z.enum(['revenue', 'quantity']).default('revenue'),
  });

  return {
    name: 'compare_products',
    description:
      'Compara as vendas de cada produto entre dois períodos e ordena pela MAIOR QUEDA ' +
      'primeiro. Use para "qual produto caiu mais em vendas". periodA é o período de ' +
      'referência (o anterior) e periodB o mais recente.',
    inputSchema: {
      tenant: TenantContextSchema,
      periodA: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
      periodB: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
      limit: z.number().optional(),
      orderBy: z.enum(['revenue', 'quantity']).optional(),
    },
    outputSchema: {
      dimension: z.string(),
      periodA: z.object({ from: z.string(), to: z.string() }),
      periodB: z.object({ from: z.string(), to: z.string() }),
      unit: z.string(),
      rows: z.array(z.object({
        key: z.string(), label: z.string(),
        valueA: z.number(), valueB: z.number(),
        delta: z.number(), deltaRatio: z.number().nullable(),
      })),
    },
    handler: async (args) => {
      const { tenant, periodA, periodB, limit, orderBy } = InputSchema.parse(args);
      const rangeA = rangeToUtc(periodA.from, periodA.to);
      const rangeB = rangeToUtc(periodB.from, periodB.to);

      const [rowsA, rowsB] = await Promise.all([
        aggregateItems(prisma, tenant.organizationId, rangeA.start, rangeA.end, 'sku'),
        aggregateItems(prisma, tenant.organizationId, rangeB.start, rangeB.end, 'sku'),
      ]);

      const pick = (row: AggregateRow) =>
        orderBy === 'revenue' ? Number(row.revenue ?? 0) : Number(row.quantity ?? 0);

      const mapA = new Map(rowsA.map((row) => [row.key ?? '', { value: pick(row), label: row.label ?? '' }]));
      const mapB = new Map(rowsB.map((row) => [row.key ?? '', { value: pick(row), label: row.label ?? '' }]));

      // União das chaves: um produto que sumiu é exatamente o que a pergunta procura.
      const keys = [...new Set([...mapA.keys(), ...mapB.keys()])];

      const rows = keys.map((key) => {
        const a = mapA.get(key);
        const b = mapB.get(key);
        const valueA = a?.value ?? 0;
        const valueB = b?.value ?? 0;
        return {
          key,
          label: a?.label || b?.label || key,
          valueA,
          valueB,
          delta: valueB - valueA,
          // Sem base no período A não existe variação percentual — `null` é
          // honesto; qualquer número aqui seria inventado.
          deltaRatio: valueA === 0 ? null : (valueB - valueA) / valueA,
        };
      });

      // Maior queda primeiro: é a resposta da pergunta que motiva a ferramenta.
      rows.sort((left, right) => left.delta - right.delta);

      return {
        dimension: 'product',
        periodA, periodB,
        unit: orderBy === 'revenue' ? 'currency' : 'count',
        rows: rows.slice(0, limit),
      };
    },
  };
}
