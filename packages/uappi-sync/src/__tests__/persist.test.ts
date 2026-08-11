import type { PrismaClient } from '@prisma/client';
import { persistOrder } from '../persist.js';
import type { MappedOrder, MappedOrderItem } from '../mapper.js';

const ORG = 'org_1';

interface FakeCustomerRow {
  id: string;
  organizationId: string;
  externalId: string;
  emailHash: string | null;
  documentHash: string | null;
  firstOrderAt: Date;
  lastOrderAt: Date;
}

/**
 * Prisma real de verdade (não mock) roda em `mcp-commerce`, que é quem tem o
 * schema/migrations neste monorepo. `uappi-sync` não tem esse setup — as
 * suítes existentes (`sync.test.ts`) já mockam o Prisma inteiro, e este teste
 * segue o mesmo padrão, mas com um fake com estado que reproduz o que a
 * consulta SQL real faz (upsert + `LEAST` no UPDATE), para provar que a
 * lógica de `firstOrderAt` monotônico é exercitada de ponta a ponta.
 */
function buildFakeDb() {
  const customers = new Map<string, FakeCustomerRow>();
  let nextId = 1;

  const commerceCustomer = {
    upsert: jest.fn(async (args: {
      where: { organizationId_externalId: { organizationId: string; externalId: string } };
      create: Omit<FakeCustomerRow, 'id'>;
      update: Partial<FakeCustomerRow>;
    }) => {
      const key = `${args.where.organizationId_externalId.organizationId}:${args.where.organizationId_externalId.externalId}`;
      const existing = customers.get(key);
      if (existing) {
        Object.assign(existing, args.update);
        return { ...existing };
      }
      const created: FakeCustomerRow = { id: `cust_${nextId++}`, ...args.create };
      customers.set(key, created);
      return { ...created };
    }),
  };

  // Reproduz `UPDATE "CommerceCustomer" SET "firstOrderAt" = LEAST("firstOrderAt", $1) WHERE "id" = $2`
  // a partir dos valores interpolados no template — não um SQL de verdade,
  // mas a mesma semântica que a consulta em persist.ts implementa.
  const executeRaw = jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const [incoming, customerId] = values as [Date, string];
    for (const row of customers.values()) {
      if (row.id === customerId && incoming.getTime() < row.firstOrderAt.getTime()) {
        row.firstOrderAt = incoming;
      }
    }
    return 1;
  });

  const commerceOrder = { upsert: jest.fn(async () => ({ id: 'order_1' })) };
  const commerceOrderItem = {
    deleteMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 0 })),
  };

  const tx = { commerceCustomer, commerceOrder, commerceOrderItem, $executeRaw: executeRaw };

  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;

  return {
    prisma,
    executeRaw,
    getCustomer: (externalId: string) => customers.get(`${ORG}:${externalId}`),
  };
}

function buildOrder(overrides: Partial<MappedOrder> = {}): MappedOrder {
  return {
    numeroPedido: overrides.numeroPedido ?? 'P1',
    idPedido: overrides.idPedido ?? 'P1',
    statusLabel: 'Pagamento aprovado',
    statusId: 3,
    statusGroup: 'PAID',
    canal: null,
    origem: null,
    tipoVenda: null,
    emittedAt: new Date('2026-06-01T00:00:00Z'),
    subtotalCents: 100,
    freightCents: 0,
    discountCents: 0,
    totalCents: 100,
    currency: 'BRL',
    paymentMethod: null,
    customer: { externalId: 'C1', emailHash: 'hash-e', documentHash: 'hash-d' },
    attribution: { source: null, medium: null, campaign: null, device: null, visitorHash: null },
    rawPayload: {},
    ...overrides,
  };
}

const NO_ITEMS: MappedOrderItem[] = [];

describe('persistOrder — firstOrderAt monotônico (B2)', () => {
  it('lowers firstOrderAt when an older order arrives after a newer one was already persisted', async () => {
    const { prisma, getCustomer } = buildFakeDb();

    // iterateOrders pagina sem ordem garantida: um pedido de 2026 pode ser
    // gravado antes de um de 2022 do mesmo cliente no mesmo backfill.
    await persistOrder({ prisma, organizationId: ORG }, buildOrder({
      numeroPedido: 'NEW', emittedAt: new Date('2026-06-01T00:00:00Z'),
    }), NO_ITEMS);
    expect(getCustomer('C1')?.firstOrderAt).toEqual(new Date('2026-06-01T00:00:00Z'));

    await persistOrder({ prisma, organizationId: ORG }, buildOrder({
      numeroPedido: 'OLD', emittedAt: new Date('2022-03-04T00:00:00Z'),
    }), NO_ITEMS);

    // Sem a correção, firstOrderAt só é setado no branch `create` do upsert e
    // fica travado em 2026-06-01 para sempre — o pedido de 2022 chegando
    // depois nunca o corrigiria.
    expect(getCustomer('C1')?.firstOrderAt).toEqual(new Date('2022-03-04T00:00:00Z'));
  });

  it('never raises firstOrderAt when a newer order arrives after an older one', async () => {
    const { prisma, getCustomer } = buildFakeDb();

    await persistOrder({ prisma, organizationId: ORG }, buildOrder({
      numeroPedido: 'OLD', emittedAt: new Date('2022-03-04T00:00:00Z'),
    }), NO_ITEMS);
    await persistOrder({ prisma, organizationId: ORG }, buildOrder({
      numeroPedido: 'NEW', emittedAt: new Date('2026-06-01T00:00:00Z'),
    }), NO_ITEMS);

    expect(getCustomer('C1')?.firstOrderAt).toEqual(new Date('2022-03-04T00:00:00Z'));
  });

  it('uses a single DB-level LEAST update rather than a read-then-write from JS', async () => {
    // A correção precisa ser um construto no próprio UPDATE (LEAST), não um
    // read-then-write em JavaScript, que teria uma corrida entre dois syncs
    // concorrentes. Trava isso verificando que $executeRaw é chamado uma vez
    // por pedido com cliente — é essa chamada que carrega o LEAST.
    const { prisma, executeRaw } = buildFakeDb();
    await persistOrder({ prisma, organizationId: ORG }, buildOrder(), NO_ITEMS);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does not touch firstOrderAt for a guest order with no linked customer', async () => {
    const { prisma, executeRaw } = buildFakeDb();
    await persistOrder({ prisma, organizationId: ORG }, buildOrder({ customer: null }), NO_ITEMS);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
