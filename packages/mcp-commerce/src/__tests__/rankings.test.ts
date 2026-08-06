import { createCompareProductsTool, createTopCategoriesTool, createTopProductsTool } from '../rankings.js';
import { prisma, resetCommerceData, seedOrders, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };

beforeAll(async () => {
  await resetCommerceData();
  await seedOrders([
    { numeroPedido: 'J1', emittedAtLocal: '2026-01-10T10:00:00', statusGroup: 'PAID', totalCents: 30000,
      items: [
        { sku: 'CAM', productName: 'Camiseta', categoryName: 'Vestuário', quantity: 4, unitPriceCents: 5000 },
        { sku: 'MEI', productName: 'Meia', categoryName: 'Vestuário', quantity: 2, unitPriceCents: 5000 },
      ] },
    { numeroPedido: 'J2', emittedAtLocal: '2026-01-20T10:00:00', statusGroup: 'DELIVERED', totalCents: 20000,
      items: [{ sku: 'TEN', productName: 'Tênis', categoryName: 'Calçados', quantity: 1, unitPriceCents: 20000 }] },
    // Cancelado: não pode aparecer em ranking de vendas
    { numeroPedido: 'J3', emittedAtLocal: '2026-01-25T10:00:00', statusGroup: 'CANCELLED', totalCents: 99999,
      items: [{ sku: 'CAM', productName: 'Camiseta', categoryName: 'Vestuário', quantity: 50, unitPriceCents: 5000 }] },
    // Fevereiro: camiseta cai, tênis sobe
    { numeroPedido: 'F1', emittedAtLocal: '2026-02-10T10:00:00', statusGroup: 'PAID', totalCents: 5000,
      items: [{ sku: 'CAM', productName: 'Camiseta', categoryName: 'Vestuário', quantity: 1, unitPriceCents: 5000 }] },
    { numeroPedido: 'F2', emittedAtLocal: '2026-02-15T10:00:00', statusGroup: 'PAID', totalCents: 60000,
      items: [{ sku: 'TEN', productName: 'Tênis', categoryName: 'Calçados', quantity: 3, unitPriceCents: 20000 }] },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

const january = { from: '2026-01-01', to: '2026-01-31', tenant };

describe('top_products', () => {
  const tool = createTopProductsTool(prisma);

  it('ranks by revenue in cents by default', async () => {
    const result = await tool.handler(january) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows.map((r) => [r.key, r.value])).toEqual([
      ['CAM', 20000], ['TEN', 20000], ['MEI', 10000],
    ].sort((a, b) => (b[1] as number) - (a[1] as number)));
  });

  it('ranks by quantity when asked', async () => {
    const result = await tool.handler({ ...january, orderBy: 'quantity' }) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows[0]).toMatchObject({ key: 'CAM', value: 4 });
  });

  it('excludes cancelled orders from the ranking', async () => {
    // J3 tem 50 camisetas canceladas; se entrassem, CAM lideraria com folga.
    const result = await tool.handler({ ...january, orderBy: 'quantity' }) as { rows: Array<{ value: number }> };
    expect(result.rows[0]?.value).toBe(4);
  });

  it('carries the product name as the label', async () => {
    const result = await tool.handler(january) as { rows: Array<{ key: string; label: string }> };
    expect(result.rows.find((r) => r.key === 'TEN')?.label).toBe('Tênis');
  });

  it('reports quantity and order count as extra metrics', async () => {
    const result = await tool.handler(january) as { rows: Array<{ key: string; extra: Record<string, number> }> };
    expect(result.rows.find((r) => r.key === 'CAM')?.extra).toMatchObject({ quantity: 4, orders: 1 });
  });

  it('computes each share of the period total', async () => {
    const result = await tool.handler(january) as { total: number; rows: Array<{ share: number }> };
    expect(result.rows.reduce((acc, r) => acc + r.share, 0)).toBeCloseTo(1, 5);
    expect(result.total).toBe(50000);
  });

  it('respects the limit', async () => {
    const result = await tool.handler({ ...january, limit: 2 }) as { rows: unknown[] };
    expect(result.rows).toHaveLength(2);
  });

  it('returns an empty ranking for a period with no sales', async () => {
    const result = await tool.handler({ ...january, from: '2025-01-01', to: '2025-01-31' }) as { rows: unknown[]; total: number };
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe('top_categories', () => {
  const tool = createTopCategoriesTool(prisma);

  it('aggregates items by category', async () => {
    const result = await tool.handler(january) as { rows: Array<{ key: string; value: number }> };
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    expect(byKey['Vestuário']).toBe(30000); // camiseta 20000 + meia 10000
    expect(byKey['Calçados']).toBe(20000);
  });

  it('sorts by revenue descending', async () => {
    const result = await tool.handler(january) as { rows: Array<{ key: string }> };
    expect(result.rows[0]?.key).toBe('Vestuário');
  });

  it('groups items with no category under a visible placeholder', async () => {
    await seedOrders([{
      numeroPedido: 'SC1', emittedAtLocal: '2026-01-28T10:00:00', statusGroup: 'PAID', totalCents: 1000,
      items: [{ sku: 'X', productName: 'Sem categoria', categoryName: null, quantity: 1, unitPriceCents: 1000 }],
    }]);
    const result = await tool.handler(january) as { rows: Array<{ key: string }> };
    expect(result.rows.map((r) => r.key)).toContain('Sem categoria');
  });
});

describe('compare_products', () => {
  const tool = createCompareProductsTool(prisma);

  const comparison = {
    tenant,
    periodA: { from: '2026-01-01', to: '2026-01-31' },
    periodB: { from: '2026-02-01', to: '2026-02-28' },
  };

  it('reports the delta between the two periods', async () => {
    const result = await tool.handler(comparison) as { rows: Array<{ key: string; valueA: number; valueB: number; delta: number }> };
    const cam = result.rows.find((r) => r.key === 'CAM');
    expect(cam).toMatchObject({ valueA: 20000, valueB: 5000, delta: -15000 });
  });

  it('sorts by the biggest drop first so the answer is at the top', async () => {
    const result = await tool.handler(comparison) as { rows: Array<{ key: string }> };
    expect(result.rows[0]?.key).toBe('CAM');
  });

  it('computes the percentage change', async () => {
    const result = await tool.handler(comparison) as { rows: Array<{ key: string; deltaRatio: number | null }> };
    expect(result.rows.find((r) => r.key === 'CAM')?.deltaRatio).toBeCloseTo(-0.75, 5);
  });

  it('reports a null ratio for a product that did not sell in period A', async () => {
    await seedOrders([{
      numeroPedido: 'NOVO', emittedAtLocal: '2026-02-20T10:00:00', statusGroup: 'PAID', totalCents: 7000,
      items: [{ sku: 'NEW', productName: 'Lançamento', quantity: 1, unitPriceCents: 7000 }],
    }]);
    const result = await tool.handler(comparison) as { rows: Array<{ key: string; deltaRatio: number | null; valueA: number }> };
    const novo = result.rows.find((r) => r.key === 'NEW');
    expect(novo?.valueA).toBe(0);
    expect(novo?.deltaRatio).toBeNull();
  });

  it('includes products present in only one of the periods', async () => {
    const result = await tool.handler(comparison) as { rows: Array<{ key: string }> };
    expect(result.rows.map((r) => r.key)).toEqual(expect.arrayContaining(['MEI', 'NEW']));
  });
});
