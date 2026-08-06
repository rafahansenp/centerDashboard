import type { IterateOrdersParams, ListOrdersPage, ListOrdersParams } from './client.js';

/**
 * O contrato que qualquer consumidor (sync, spikes) deve depender — nunca da
 * classe concreta `UappiClient`. É o que permite `MockUappiClient` substituir
 * o cliente real sem que `packages/uappi-sync` saiba a diferença.
 */
export interface UappiClientLike {
  listOrders(params: ListOrdersParams): Promise<ListOrdersPage>;
  getOrder(numeroPedido: string): Promise<unknown>;
  iterateOrders(params: IterateOrdersParams): AsyncGenerator<unknown[]>;
}
