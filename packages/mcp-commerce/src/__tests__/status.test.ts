import { createFailedOrdersTool, createOrdersByStatusTool, createPaymentMethodTool } from '../status.js';
import { prisma, resetCommerceData, seedOrders, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };
const period = { from: '2026-01-01', to: '2026-01-31', tenant };

beforeAll(async () => {
  await resetCommerceData();
  await seedOrders([
    { numeroPedido: 'P1', emittedAtLocal: '2026-01-10T10:00:00', statusGroup: 'PAID', totalCents: 10000, paymentMethod: 'pix' },
    { numeroPedido: 'P2', emittedAtLocal: '2026-01-11T10:00:00', statusGroup: 'PAID', totalCents: 30000, paymentMethod: 'pix' },
    { numeroPedido: 'P3', emittedAtLocal: '2026-01-12T10:00:00', statusGroup: 'DELIVERED', totalCents: 20000, paymentMethod: 'cartao' },
    { numeroPedido: 'P4', emittedAtLocal: '2026-01-13T10:00:00', statusGroup: 'CANCELLED', totalCents: 15000, paymentMethod: 'cartao' },
    { numeroPedido: 'P5', emittedAtLocal: '2026-01-14T10:00:00', statusGroup: 'CANCELLED', totalCents: 5000, paymentMethod: 'boleto' },
    { numeroPedido: 'P6', emittedAtLocal: '2026-01-15T10:00:00', statusGroup: 'PENDING_PAYMENT', totalCents: 8000, paymentMethod: 'boleto' },
    { numeroPedido: 'P7', emittedAtLocal: '2026-01-16T09:00:00', statusGroup: 'FAILED', totalCents: 12000, paymentMethod: 'cartao' },
    { numeroPedido: 'P8', emittedAtLocal: '2026-01-17T09:00:00', statusGroup: 'FAILED', totalCents: 4000, paymentMethod: 'cartao' },
    // Fora da janela
    { numeroPedido: 'P9', emittedAtLocal: '2026-02-05T10:00:00', statusGroup: 'CANCELLED', totalCents: 99999 },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

describe('orders_by_status', () => {
  const tool = createOrdersByStatusTool(prisma);

  it('is named orders_by_status', () => {
    expect(tool.name).toBe('orders_by_status');
  });

  it('counts orders and revenue per status group', async () => {
    const result = await tool.handler(period) as { groups: Array<Record<string, unknown>> };
    const byGroup = Object.fromEntries(result.groups.map((g) => [g.group, g]));

    expect(byGroup.PAID).toMatchObject({ orders: 2, revenueCents: 40000 });
    expect(byGroup.DELIVERED).toMatchObject({ orders: 1, revenueCents: 20000 });
    expect(byGroup.CANCELLED).toMatchObject({ orders: 2, revenueCents: 20000 });
    expect(byGroup.PENDING_PAYMENT).toMatchObject({ orders: 1 });
    expect(byGroup.FAILED).toMatchObject({ orders: 2 });
  });

  it('attaches a Portuguese label to every group', async () => {
    const result = await tool.handler(period) as { groups: Array<Record<string, unknown>> };
    expect(result.groups.find((g) => g.group === 'PENDING_PAYMENT')?.label).toBe('Aguardando pagamento');
    expect(result.groups.find((g) => g.group === 'CANCELLED')?.label).toBe('Cancelado');
  });

  it('computes each share of the total order count', async () => {
    const result = await tool.handler(period) as { groups: Array<{ share: number }> };
    const sum = result.groups.reduce((acc, g) => acc + g.share, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('sorts by order count descending', async () => {
    const result = await tool.handler(period) as { groups: Array<{ orders: number }> };
    const counts = result.groups.map((g) => g.orders);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('excludes orders outside the window', async () => {
    const result = await tool.handler(period) as { groups: Array<{ group: string; orders: number }> };
    expect(result.groups.find((g) => g.group === 'CANCELLED')?.orders).toBe(2);
  });

  it('returns an empty group list for a period with no orders', async () => {
    const result = await tool.handler({ ...period, from: '2025-01-01', to: '2025-01-31' }) as { groups: unknown[] };
    expect(result.groups).toEqual([]);
  });
});

describe('failed_orders', () => {
  const tool = createFailedOrdersTool(prisma);

  it('returns only FAILED orders, most recent first', async () => {
    const result = await tool.handler(period) as { total: number; orders: Array<{ numeroPedido: string }> };
    expect(result.total).toBe(2);
    expect(result.orders.map((o) => o.numeroPedido)).toEqual(['P8', 'P7']);
  });

  it('respects the limit', async () => {
    const result = await tool.handler({ ...period, limit: 1 }) as { orders: unknown[]; total: number };
    expect(result.orders).toHaveLength(1);
    // O total continua sendo o total real, não o tamanho da página.
    expect(result.total).toBe(2);
  });

  it('exposes no personal data about the customer', async () => {
    const result = await tool.handler(period);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/@/);
    expect(serialized).not.toMatch(/emailHash|documentHash/);
  });
});

describe('payment_method_performance', () => {
  const tool = createPaymentMethodTool(prisma);

  it('computes conversion per payment method', async () => {
    const result = await tool.handler(period) as { methods: Array<Record<string, number | string>> };
    const byMethod = Object.fromEntries(result.methods.map((m) => [m.method, m]));

    // pix: 2 pagos, 0 falhos → 100%
    expect(byMethod.pix).toMatchObject({ paidOrders: 2, failedOrders: 0, conversionRate: 1 });
    // cartao: 1 pago (P3 DELIVERED), 2 falhos (P7,P8) — P4 é cancelado, não falha
    expect(byMethod.cartao).toMatchObject({ paidOrders: 1, failedOrders: 2 });
    expect(byMethod.cartao?.conversionRate).toBeCloseTo(1 / 3, 5);
  });

  it('reports revenue and average ticket per method', async () => {
    const result = await tool.handler(period) as { methods: Array<Record<string, number | string>> };
    const pix = result.methods.find((m) => m.method === 'pix');
    expect(pix).toMatchObject({ revenueCents: 40000, averageTicketCents: 20000 });
  });

  it('sorts by conversion rate descending', async () => {
    const result = await tool.handler(period) as { methods: Array<{ conversionRate: number }> };
    const rates = result.methods.map((m) => m.conversionRate);
    expect([...rates].sort((a, b) => b - a)).toEqual(rates);
  });

  it('does not divide by zero for a method with no attempts in the window', async () => {
    const result = await tool.handler({ ...period, from: '2025-01-01', to: '2025-01-31' }) as { methods: unknown[] };
    expect(result.methods).toEqual([]);
  });
});
