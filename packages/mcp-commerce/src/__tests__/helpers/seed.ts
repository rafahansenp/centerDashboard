import { PrismaClient } from '@prisma/client';

export const TEST_ORG = 'org_test_commerce';

export interface SeedItem {
  sku: string;
  productName: string;
  categoryName?: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface SeedOrder {
  numeroPedido: string;
  /** ISO local de São Paulo, ex.: '2026-01-15T10:00:00'. */
  emittedAtLocal: string;
  statusGroup: 'PAID' | 'PENDING_PAYMENT' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'FAILED' | 'OTHER';
  totalCents: number;
  customerExternalId?: string;
  paymentMethod?: string;
  canal?: string;
  campaign?: string | null;
  device?: string | null;
  visitorHash?: string | null;
  items?: SeedItem[];
}

export const prisma = new PrismaClient();

/** '2026-01-15T10:00:00' em São Paulo (UTC-3) → Date UTC. */
function toUtc(local: string): Date {
  return new Date(`${local}-03:00`);
}

export async function resetCommerceData(): Promise<void> {
  await prisma.commerceOrderItem.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.commerceOrder.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.commerceCustomer.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.organization.upsert({
    where: { id: TEST_ORG },
    update: {},
    create: { id: TEST_ORG, name: 'Loja de Teste' },
  });
}

export async function seedOrders(orders: SeedOrder[]): Promise<void> {
  for (const order of orders) {
    const emittedAt = toUtc(order.emittedAtLocal);

    let customerId: string | null = null;
    if (order.customerExternalId) {
      const customer = await prisma.commerceCustomer.upsert({
        where: {
          organizationId_externalId: {
            organizationId: TEST_ORG, externalId: order.customerExternalId,
          },
        },
        create: {
          organizationId: TEST_ORG,
          externalId: order.customerExternalId,
          firstOrderAt: emittedAt,
          lastOrderAt: emittedAt,
        },
        update: {},
      });
      customerId = customer.id;
      // firstOrderAt é o mínimo entre o existente e este pedido.
      if (customer.firstOrderAt && emittedAt < customer.firstOrderAt) {
        await prisma.commerceCustomer.update({
          where: { id: customer.id }, data: { firstOrderAt: emittedAt },
        });
      }
    }

    const saved = await prisma.commerceOrder.create({
      data: {
        organizationId: TEST_ORG,
        numeroPedido: order.numeroPedido,
        idPedido: order.numeroPedido,
        statusLabel: order.statusGroup,
        statusId: 1,
        statusGroup: order.statusGroup,
        canal: order.canal ?? 'site',
        emittedAt,
        subtotalCents: order.totalCents,
        freightCents: 0,
        discountCents: 0,
        totalCents: order.totalCents,
        paymentMethod: order.paymentMethod ?? 'pix',
        customerId,
        attributionCampaign: order.campaign ?? null,
        attributionDevice: order.device ?? null,
        visitorHash: order.visitorHash ?? null,
        rawPayload: {},
      },
    });

    if (order.items?.length) {
      await prisma.commerceOrderItem.createMany({
        data: order.items.map((item) => ({
          organizationId: TEST_ORG,
          orderId: saved.id,
          sku: item.sku,
          productName: item.productName,
          categoryName: item.categoryName ?? null,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          totalPriceCents: item.unitPriceCents * item.quantity,
          emittedAt,
        })),
      });
    }
  }
}
