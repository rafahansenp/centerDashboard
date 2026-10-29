import type { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import type { UappiClientLike } from '@center/uappi-client';
import { runCommerceSync, SYNC_RESOURCE } from '../runner.js';
import { createUappiConnector } from '../uappi/connector.js';

const pseudonymizer = new Pseudonymizer('p'.repeat(32));

function orderPayload(numeroPedido: string, dataEmissao = '2026-07-15 10:00:00', total = 100) {
  return {
    idPedido: numeroPedido, numeroPedido, dataEmissao, moeda: 'BRL',
    status: { id: 3, descricao: 'Pagamento aprovado' },
    cliente: { idCliente: '555', email: 'ana@example.com' },
    valores: { subtotal: total, frete: 0, descontos: 0, totalPedido: total },
    pagamento: [{ descricao: 'Pix', valor: total }],
    itens: [{ sku: 'A1', descricao: 'Produto', quantidade: 1, valorUnitario: total, valorTotal: total }],
  };
}

function buildDeps(pages: unknown[][], detailOverrides: Record<string, unknown> = {}) {
  const iterateOrders = jest.fn(async function* () {
    for (const page of pages) yield page;
  });
  const getOrder = jest.fn(async (numeroPedido: string) =>
    detailOverrides[numeroPedido] ?? orderPayload(numeroPedido));

  const upsertOrder = jest.fn(async () => ({ id: `db_${Math.random()}` }));
  const upsertCustomer = jest.fn(async () => ({ id: 'cust_1' }));
  const deleteItems = jest.fn(async () => ({ count: 0 }));
  const createItems = jest.fn(async () => ({ count: 1 }));
  const upsertSyncState = jest.fn(async () => ({}));
  const findSyncState = jest.fn(async () => null);
  // persistOrder emite um LEAST(...) via $executeRaw para manter firstOrderAt
  // monotônico (B2) sempre que o pedido tem cliente — o mock da transação
  // precisa oferecer o método, senão toda chamada com cliente quebraria.
  const executeRaw = jest.fn(async () => 1);

  const prisma = {
    commerceOrder: { upsert: upsertOrder },
    commerceCustomer: { upsert: upsertCustomer },
    commerceOrderItem: { deleteMany: deleteItems, createMany: createItems },
    syncState: { findUnique: findSyncState, upsert: upsertSyncState },
    $executeRaw: executeRaw,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        commerceOrder: { upsert: upsertOrder },
        commerceCustomer: { upsert: upsertCustomer },
        commerceOrderItem: { deleteMany: deleteItems, createMany: createItems },
        $executeRaw: executeRaw,
      })),
  } as unknown as PrismaClient;

  return {
    deps: {
      prisma,
      connector: createUappiConnector({
        baseUrl: 'http://uappi.test',
        mock: true,
        buildClient: () => ({ iterateOrders, getOrder }) as unknown as UappiClientLike,
      }),
      settings: { credentials: { apiKey: 'ak', secretKey: 'sk' }, statusOverrides: null },
      pseudonymizer,
      organizationId: 'org_1',
      now: () => new Date('2026-07-20T12:00:00Z'),
    },
    iterateOrders, getOrder, upsertOrder, upsertCustomer, createItems,
    findSyncState, upsertSyncState, executeRaw,
  };
}

describe('runCommerceSync', () => {
  it('runs a backfill first when none has ever completed', async () => {
    const { deps, iterateOrders, findSyncState } = buildDeps([]);
    (findSyncState as jest.Mock).mockResolvedValueOnce(null);
    await runCommerceSync(deps);
    // Sem backfill anterior, a janela é longa (padrão de 90 dias).
    expect(iterateOrders).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-04-21', to: '2026-07-20' }),
    );
  });

  it('re-reads the last few days so status changes are caught', async () => {
    const { deps, iterateOrders, findSyncState } = buildDeps([]);
    (findSyncState as jest.Mock).mockResolvedValueOnce({
      cursorDate: '2026-07-19',
      backfillDoneAt: new Date('2026-07-01T00:00:00Z'),
    });
    await runCommerceSync(deps);
    // cursor 2026-07-19 menos 3 dias de sobreposição.
    expect(iterateOrders).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-07-16', to: '2026-07-20' }),
    );
  });

  it('honours a custom overlap', async () => {
    const { deps, iterateOrders, findSyncState } = buildDeps([]);
    (findSyncState as jest.Mock).mockResolvedValueOnce({
      cursorDate: '2026-07-19',
      backfillDoneAt: new Date('2026-07-01T00:00:00Z'),
    });
    await runCommerceSync(deps, { overlapDays: 7 });
    expect(iterateOrders).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-07-12', to: '2026-07-20' }),
    );
  });

  it('advances the cursor to today after a successful run', async () => {
    const { deps, upsertSyncState, findSyncState } = buildDeps([[{ numeroPedido: 'P1' }]]);
    (findSyncState as jest.Mock).mockResolvedValueOnce({
      cursorDate: '2026-07-19', backfillDoneAt: new Date('2026-07-01T00:00:00Z'),
    });
    await runCommerceSync(deps);
    expect(upsertSyncState).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ cursorDate: '2026-07-20', lastError: null }),
    }));
  });

  it('records the error and does not advance the cursor when the API fails', async () => {
    const { deps, upsertSyncState, findSyncState, iterateOrders } = buildDeps([]);
    (findSyncState as jest.Mock).mockResolvedValueOnce({
      cursorDate: '2026-07-19', backfillDoneAt: new Date('2026-07-01T00:00:00Z'),
    });
    (iterateOrders as jest.Mock).mockImplementationOnce(async function* () {
      throw new Error('Uappi respondeu 503');
    });

    await expect(runCommerceSync(deps)).rejects.toThrow('Uappi respondeu 503');
    expect(upsertSyncState).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ lastError: 'Uappi respondeu 503' }),
    }));
    const call = (upsertSyncState as jest.Mock).mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(call.update.cursorDate).toBeUndefined();
  });

  it('counts ReadFailure as ordersFailed without moving the cursor on total failure', async () => {
    const { deps, getOrder, upsertSyncState } = buildDeps([
      [{ numeroPedido: 'P1' }, { semNumero: true }],
    ]);
    (getOrder as jest.Mock).mockRejectedValueOnce(new Error('Uappi respondeu 500'));
    const result = await runCommerceSync(deps);
    expect(result).toMatchObject({ ordersProcessed: 0, ordersFailed: 2 });
    expect(upsertSyncState).toHaveBeenCalledTimes(1);

    // Falha total (listagem): o cursor não anda.
    const second = buildDeps([]);
    (second.iterateOrders as jest.Mock).mockImplementationOnce(async function* () {
      throw new Error('Uappi respondeu 503');
    });
    await expect(runCommerceSync(second.deps)).rejects.toThrow('503');
    const call = (second.upsertSyncState as jest.Mock).mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(call.update.cursorDate).toBeUndefined();
  });
});
