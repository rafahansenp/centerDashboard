import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { REVENUE_STATUS_GROUPS, rangeToUtc } from './constants.js';

export const STATUS_LABELS: Record<string, string> = {
  PAID: 'Pago',
  PENDING_PAYMENT: 'Aguardando pagamento',
  PROCESSING: 'Em separação',
  SHIPPED: 'Enviado',
  DELIVERED: 'Entregue',
  CANCELLED: 'Cancelado',
  FAILED: 'Falhou',
  OTHER: 'Outro',
};

const PeriodInput = {
  from: IsoDateSchema,
  to: IsoDateSchema,
  tenant: TenantContextSchema,
};

const PeriodSchema = z.object({ from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema });

export function createOrdersByStatusTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'orders_by_status',
    description:
      'Quantidade de pedidos e valor por situação (pago, aguardando pagamento, cancelado, ' +
      'falhou, entregue…) no período. Use para "quantos pedidos foram cancelados" e ' +
      '"quantos aguardam pagamento".',
    inputSchema: PeriodInput,
    outputSchema: {
      from: z.string(), to: z.string(),
      groups: z.array(z.object({
        group: z.string(), label: z.string(),
        orders: z.number(), revenueCents: z.number(), share: z.number(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      const rows = await prisma.$queryRaw<Array<{ status_group: string; orders: bigint; revenue: bigint | null }>>(Prisma.sql`
        SELECT o."statusGroup"::text AS status_group,
               COUNT(*)::bigint AS orders,
               SUM(o."totalCents")::bigint AS revenue
        FROM "CommerceOrder" o
        WHERE o."organizationId" = ${tenant.organizationId}
          AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
        GROUP BY 1
        ORDER BY 2 DESC
      `);

      const totalOrders = rows.reduce((acc, row) => acc + Number(row.orders), 0);

      return {
        from, to,
        groups: rows.map((row) => ({
          group: row.status_group,
          label: STATUS_LABELS[row.status_group] ?? row.status_group,
          orders: Number(row.orders),
          revenueCents: Number(row.revenue ?? 0),
          share: totalOrders === 0 ? 0 : Number(row.orders) / totalOrders,
        })),
      };
    },
  };
}

export function createFailedOrdersTool(prisma: PrismaClient): AnalysisTool {
  const InputSchema = PeriodSchema.extend({ limit: z.number().int().min(1).max(50).default(10) });

  return {
    name: 'failed_orders',
    description:
      'Lista os pedidos cuja compra falhou (pagamento recusado, não autorizado, estornado) ' +
      'no período, do mais recente para o mais antigo. Não expõe dados do cliente.',
    inputSchema: { ...PeriodInput, limit: z.number().optional() },
    outputSchema: {
      from: z.string(), to: z.string(), total: z.number(),
      orders: z.array(z.object({
        numeroPedido: z.string(), statusLabel: z.string(),
        emittedAt: z.string(), totalCents: z.number(), paymentMethod: z.string().nullable(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant, limit } = InputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      const where = {
        organizationId: tenant.organizationId,
        statusGroup: 'FAILED' as const,
        emittedAt: { gte: start, lt: end },
      };

      const [total, orders] = await Promise.all([
        prisma.commerceOrder.count({ where }),
        prisma.commerceOrder.findMany({
          where,
          orderBy: { emittedAt: 'desc' },
          take: limit,
          // Seleção explícita: nada de cliente entra na resposta.
          select: {
            numeroPedido: true, statusLabel: true, emittedAt: true,
            totalCents: true, paymentMethod: true,
          },
        }),
      ]);

      return {
        from, to, total,
        orders: orders.map((order) => ({
          numeroPedido: order.numeroPedido,
          statusLabel: order.statusLabel,
          emittedAt: order.emittedAt.toISOString(),
          totalCents: order.totalCents,
          paymentMethod: order.paymentMethod,
        })),
      };
    },
  };
}

export function createPaymentMethodTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'payment_method_performance',
    description:
      'Compara os métodos de pagamento por taxa de conversão (pedidos concluídos sobre ' +
      'tentativas), faturamento e ticket médio. Use para "qual método de pagamento converte mais".',
    inputSchema: PeriodInput,
    outputSchema: {
      from: z.string(), to: z.string(),
      methods: z.array(z.object({
        method: z.string(), paidOrders: z.number(), failedOrders: z.number(),
        conversionRate: z.number(), revenueCents: z.number(), averageTicketCents: z.number(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      // Conversão = concluídos / (concluídos + falhos). Cancelamentos ficam de
      // fora: cancelar é decisão do cliente, não falha do meio de pagamento.
      const rows = await prisma.$queryRaw<Array<{
        method: string | null; paid: bigint; failed: bigint; revenue: bigint | null;
      }>>(Prisma.sql`
        SELECT o."paymentMethod" AS method,
               COUNT(*) FILTER (WHERE o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)}))::bigint AS paid,
               COUNT(*) FILTER (WHERE o."statusGroup"::text = 'FAILED')::bigint AS failed,
               SUM(o."totalCents") FILTER (WHERE o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)}))::bigint AS revenue
        FROM "CommerceOrder" o
        WHERE o."organizationId" = ${tenant.organizationId}
          AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
          AND o."paymentMethod" IS NOT NULL
        GROUP BY 1
      `);

      const methods = rows.map((row) => {
        const paid = Number(row.paid);
        const failed = Number(row.failed);
        const attempts = paid + failed;
        const revenue = Number(row.revenue ?? 0);
        return {
          method: row.method ?? 'desconhecido',
          paidOrders: paid,
          failedOrders: failed,
          conversionRate: attempts === 0 ? 0 : paid / attempts,
          revenueCents: revenue,
          averageTicketCents: paid === 0 ? 0 : Math.round(revenue / paid),
        };
      });

      methods.sort((a, b) => b.conversionRate - a.conversionRate);
      return { from, to, methods };
    },
  };
}
