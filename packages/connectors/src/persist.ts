import type { Prisma, PrismaClient } from '@prisma/client';
import type { MappedOrder, MappedOrderItem } from './uappi/mapper.js';

export interface PersistDeps {
  prisma: PrismaClient;
  organizationId: string;
}

/**
 * Grava um pedido de forma idempotente.
 *
 * Tudo numa transação: um pedido com itens pela metade produziria "produto mais
 * vendido" errado, e esse tipo de erro é invisível até alguém conferir à mão.
 * Os itens são apagados e recriados em vez de atualizados — o pedido pode ter
 * itens removidos entre um sync e outro, e um update deixaria órfãos.
 */
export async function persistOrder(
  deps: PersistDeps,
  order: MappedOrder,
  items: MappedOrderItem[],
): Promise<void> {
  const { prisma, organizationId } = deps;

  await prisma.$transaction(async (tx) => {
    let customerId: string | null = null;

    if (order.customer) {
      const customer = await tx.commerceCustomer.upsert({
        where: {
          organizationId_externalId: {
            organizationId,
            externalId: order.customer.externalId,
          },
        },
        create: {
          organizationId,
          externalId: order.customer.externalId,
          emailHash: order.customer.emailHash,
          documentHash: order.customer.documentHash,
          firstOrderAt: order.emittedAt,
          lastOrderAt: order.emittedAt,
        },
        update: {
          emailHash: order.customer.emailHash,
          documentHash: order.customer.documentHash,
        },
      });
      customerId = customer.id;

      // `firstOrderAt` precisa ser monotonicamente o pedido mais antigo já
      // visto. `iterateOrders` pagina por offset sem ordem garantida, então um
      // pedido de 2022 pode chegar DEPOIS de um de 2026 no mesmo backfill — o
      // `create` acima só cobre a primeira vez que o cliente aparece; sem
      // isto, um sync reentrante nunca corrigiria `firstOrderAt` para um
      // pedido mais antigo encontrado depois. `LEAST` dentro do próprio
      // UPDATE (não um read-then-write em JS) evita a corrida de dois syncs
      // concorrentes lendo o mesmo valor antigo e escrevendo o mesmo "mínimo"
      // desatualizado.
      await tx.$executeRaw`
        UPDATE "CommerceCustomer"
        SET "firstOrderAt" = LEAST("firstOrderAt", ${order.emittedAt})
        WHERE "id" = ${customer.id}
      `;
    }

    const orderData = {
      organizationId,
      numeroPedido: order.numeroPedido,
      idPedido: order.idPedido,
      statusLabel: order.statusLabel,
      statusId: order.statusId,
      statusGroup: order.statusGroup,
      canal: order.canal,
      origem: order.origem,
      tipoVenda: order.tipoVenda,
      emittedAt: order.emittedAt,
      subtotalCents: order.subtotalCents,
      freightCents: order.freightCents,
      discountCents: order.discountCents,
      totalCents: order.totalCents,
      currency: order.currency,
      paymentMethod: order.paymentMethod,
      customerId,
      attributionSource: order.attribution.source,
      attributionMedium: order.attribution.medium,
      attributionCampaign: order.attribution.campaign,
      attributionDevice: order.attribution.device,
      visitorHash: order.attribution.visitorHash,
      rawPayload: order.rawPayload as Prisma.InputJsonValue,
      syncedAt: new Date(),
    };

    const saved = await tx.commerceOrder.upsert({
      where: {
        organizationId_numeroPedido: { organizationId, numeroPedido: order.numeroPedido },
      },
      create: orderData,
      update: orderData,
    });

    await tx.commerceOrderItem.deleteMany({ where: { orderId: saved.id } });

    if (items.length > 0) {
      await tx.commerceOrderItem.createMany({
        data: items.map((item) => ({
          organizationId,
          orderId: saved.id,
          sku: item.sku,
          productName: item.productName,
          categoryName: item.categoryName,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          totalPriceCents: item.totalPriceCents,
          emittedAt: order.emittedAt,
        })),
      });
    }
  });
}
