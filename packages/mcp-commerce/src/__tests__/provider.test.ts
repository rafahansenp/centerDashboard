import type { MetricQuery } from '@center/shared';
import { createCommerceProvider } from '../provider.js';
import { prisma, resetCommerceData, seedOrders, TEST_ORG } from './helpers/seed.js';

const provider = createCommerceProvider(prisma);

const tenant = { organizationId: TEST_ORG, externalIds: {} };

function query(overrides: Partial<MetricQuery> = {}): MetricQuery {
  return {
    metricId: 'commerce.revenue',
    from: '2026-01-01', to: '2026-01-31', granularity: 'day', tenant,
    ...overrides,
  };
}

beforeAll(async () => {
  await resetCommerceData();
  await seedOrders([
    // 15/01: duas vendas válidas (R$ 100 + R$ 200)
    { numeroPedido: 'P1', emittedAtLocal: '2026-01-15T10:00:00', statusGroup: 'PAID',
      totalCents: 10000, customerExternalId: 'C1', paymentMethod: 'pix', campaign: 'black-friday', device: 'mobile',
      items: [{ sku: 'CAM-001', productName: 'Camiseta', categoryName: 'Vestuário', quantity: 2, unitPriceCents: 5000 }] },
    { numeroPedido: 'P2', emittedAtLocal: '2026-01-15T18:00:00', statusGroup: 'DELIVERED',
      totalCents: 20000, customerExternalId: 'C2', paymentMethod: 'cartao', campaign: 'black-friday', device: 'desktop',
      items: [{ sku: 'TEN-002', productName: 'Tênis', categoryName: 'Calçados', quantity: 1, unitPriceCents: 20000 }] },
    // 20/01: um cancelado e um aguardando — NÃO são receita
    { numeroPedido: 'P3', emittedAtLocal: '2026-01-20T10:00:00', statusGroup: 'CANCELLED',
      totalCents: 99999, customerExternalId: 'C3' },
    { numeroPedido: 'P4', emittedAtLocal: '2026-01-20T11:00:00', statusGroup: 'PENDING_PAYMENT',
      totalCents: 88888, customerExternalId: 'C4' },
    // 31/01 23:30 São Paulo — prova que a janela usa timezone de negócio
    { numeroPedido: 'P5', emittedAtLocal: '2026-01-31T23:30:00', statusGroup: 'PAID',
      totalCents: 5000, customerExternalId: 'C1' },
    // Fevereiro: fora da janela
    { numeroPedido: 'P6', emittedAtLocal: '2026-02-01T10:00:00', statusGroup: 'PAID',
      totalCents: 77777, customerExternalId: 'C5' },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

describe('catálogo', () => {
  it('publishes the five commerce metrics', () => {
    expect(provider.descriptors.map((d) => d.id).sort()).toEqual([
      'commerce.average_ticket', 'commerce.items_sold',
      'commerce.new_customers', 'commerce.orders', 'commerce.revenue',
    ]);
  });

  it('declares revenue and average ticket in currency', () => {
    for (const id of ['commerce.revenue', 'commerce.average_ticket']) {
      expect(provider.descriptors.find((d) => d.id === id)?.unit).toBe('currency');
    }
  });
});

describe('commerce.revenue', () => {
  it('sums only sales-status orders, in cents', async () => {
    // P1 + P2 + P5 = 10000 + 20000 + 5000. P3/P4 excluídos, P6 fora da janela.
    expect((await provider.query(query())).total).toBe(35000);
  });

  it('buckets by the business timezone, not UTC', async () => {
    // P5 é 31/01 23:30 em São Paulo = 01/02 02:30 UTC. Precisa cair em 31/01.
    const series = await provider.query(query());
    expect(series.points.find((p) => p.date === '2026-01-31')?.value).toBe(5000);
  });

  it('fills days without sales with zero', async () => {
    const series = await provider.query(query());
    expect(series.points).toHaveLength(31);
    expect(series.points.find((p) => p.date === '2026-01-02')?.value).toBe(0);
  });

  it('collapses to a single point at month granularity', async () => {
    const series = await provider.query(query({ granularity: 'month' }));
    expect(series.points).toEqual([{ date: '2026-01-01', value: 35000 }]);
  });

  it('groups by payment method', async () => {
    const series = await provider.query(query({ to: '2026-01-15', groupBy: 'paymentMethod' }));
    expect(series.points.filter((p) => p.date === '2026-01-15')).toEqual([
      { date: '2026-01-15', value: 20000, group: 'cartao' },
      { date: '2026-01-15', value: 10000, group: 'pix' },
    ]);
  });

  it('filters by campaign', async () => {
    const series = await provider.query(query({ filters: { campaign: 'black-friday' } }));
    expect(series.total).toBe(30000); // P5 não tem campanha
  });

  it('returns zero for a range with no orders', async () => {
    expect((await provider.query(query({ from: '2025-01-01', to: '2025-01-31' }))).total).toBe(0);
  });

  it('never leaks another organization data', async () => {
    const series = await provider.query(query({
      tenant: { organizationId: 'org_outra', externalIds: {} },
    }));
    expect(series.total).toBe(0);
  });
});

describe('commerce.orders', () => {
  it('counts only sales-status orders', async () => {
    expect((await provider.query(query({ metricId: 'commerce.orders' }))).total).toBe(3);
  });
});

describe('commerce.average_ticket', () => {
  it('divides revenue by order count, in cents', async () => {
    // 35000 / 3 = 11666.67 → arredonda para 11667 centavos.
    const series = await provider.query(query({ metricId: 'commerce.average_ticket', granularity: 'month' }));
    expect(series.points[0]?.value).toBe(11667);
  });

  it('returns zero instead of dividing by zero on an empty day', async () => {
    const series = await provider.query(query({ metricId: 'commerce.average_ticket' }));
    expect(series.points.find((p) => p.date === '2026-01-02')?.value).toBe(0);
  });

  it('reports the period average as the total, not the sum of daily averages', async () => {
    // Somar médias diárias daria 15000+5000 = 20000, que não é o ticket médio.
    const series = await provider.query(query({ metricId: 'commerce.average_ticket' }));
    expect(series.total).toBe(11667);
  });

  it('returns a zero total instead of dividing by zero over a period with no orders at all', async () => {
    const series = await provider.query(query({
      metricId: 'commerce.average_ticket', from: '2025-01-01', to: '2025-01-31',
    }));
    expect(series.total).toBe(0);
  });
});

describe('commerce.items_sold', () => {
  it('sums item quantities of sales-status orders', async () => {
    // P1: 2 camisetas, P2: 1 tênis. P5 não tem itens.
    expect((await provider.query(query({ metricId: 'commerce.items_sold' }))).total).toBe(3);
  });

  it('also aggregates at week and month granularity', async () => {
    const week = await provider.query(query({ metricId: 'commerce.items_sold', granularity: 'week' }));
    const month = await provider.query(query({ metricId: 'commerce.items_sold', granularity: 'month' }));
    expect(week.total).toBe(3);
    expect(month.total).toBe(3);
  });

  it('groups items_sold by a dimension too', async () => {
    const series = await provider.query(query({
      metricId: 'commerce.items_sold', to: '2026-01-15', groupBy: 'paymentMethod',
    }));
    expect(series.points.filter((p) => p.date === '2026-01-15').map((p) => p.group).sort())
      .toEqual(['cartao', 'pix']);
  });
});

describe('commerce.new_customers', () => {
  it('counts customers whose first order falls in the window', async () => {
    // C1, C2, C3, C4 tiveram o primeiro pedido em janeiro. C5 em fevereiro.
    expect((await provider.query(query({ metricId: 'commerce.new_customers' }))).total).toBe(4);
  });

  it('does not count a returning customer twice', async () => {
    // C1 comprou em 15/01 e 31/01; conta uma vez, no dia do primeiro pedido.
    const series = await provider.query(query({ metricId: 'commerce.new_customers' }));
    expect(series.points.find((p) => p.date === '2026-01-31')?.value).toBe(0);
  });

  it('also aggregates at week and month granularity', async () => {
    const week = await provider.query(query({ metricId: 'commerce.new_customers', granularity: 'week' }));
    const month = await provider.query(query({ metricId: 'commerce.new_customers', granularity: 'month' }));
    expect(week.total).toBe(4);
    expect(month.total).toBe(4);
  });
});

describe('métrica desconhecida', () => {
  it('rejects an unknown metric id', async () => {
    await expect(provider.query(query({ metricId: 'commerce.inventado' })))
      .rejects.toThrow('métrica desconhecida');
  });
});

describe('dimensão desconhecida', () => {
  it('rejects an unsupported groupBy dimension', async () => {
    await expect(provider.query(query({ groupBy: 'inventada' })))
      .rejects.toThrow('dimensão não suportada');
  });

  it('rejects an unsupported filter dimension', async () => {
    await expect(provider.query(query({ filters: { inventada: 'x' } })))
      .rejects.toThrow('dimensão não suportada');
  });
});
