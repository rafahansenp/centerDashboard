import { MAX_PAGE_SIZE, UappiApiError, type ListOrdersPage, type ListOrdersParams } from './client.js';
import type { UappiClientLike } from './interface.js';
import { FIXTURE_ORDERS, FIXTURE_ORDER_NUMBERS } from './__fixtures__/orders.fixture.js';

interface FixtureOrder { numeroPedido: string; dataEmissao: string }

/**
 * Mesma forma pública do `UappiClient`, respondendo com dados fixos.
 * Nunca faz rede — existe para desenvolver e demonstrar o sistema inteiro sem
 * credenciais reais. Ligado por `MOCK_EXTERNAL_APIS=true` (T4), nunca em produção.
 */
export class MockUappiClient implements UappiClientLike {
  private readonly orders: FixtureOrder[] = FIXTURE_ORDER_NUMBERS
    .map((key) => FIXTURE_ORDERS[key] as FixtureOrder)
    .sort((a, b) => a.dataEmissao.localeCompare(b.dataEmissao));

  async listOrders(params: ListOrdersParams): Promise<ListOrdersPage> {
    const limit = Math.min(params.limit, MAX_PAGE_SIZE);
    const inRange = this.orders.filter((order) => {
      const date = order.dataEmissao.slice(0, 10);
      return date >= params.from && date <= params.to;
    });
    const page = inRange.slice(params.offset, params.offset + limit);

    return {
      pedidos: page,
      info: { offset: params.offset, limit, total: inRange.length, exibindo: page.length },
    };
  }

  async getOrder(numeroPedido: string): Promise<unknown> {
    const order = FIXTURE_ORDERS[numeroPedido];
    if (!order) {
      throw new UappiApiError(404, `Uappi respondeu 404 em /v2/orders/${numeroPedido} (mock)`);
    }
    return order;
  }

  async *iterateOrders(params: { from: string; to: string; pageSize?: number }): AsyncGenerator<unknown[]> {
    const pageSize = Math.min(params.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    let offset = 0;
    for (;;) {
      const page = await this.listOrders({ from: params.from, to: params.to, offset, limit: pageSize });
      if (page.pedidos.length === 0) return;
      yield page.pedidos;
      offset += page.pedidos.length;
      if (offset >= page.info.total) return;
    }
  }
}
