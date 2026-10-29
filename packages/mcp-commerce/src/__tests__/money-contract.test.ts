import { Pseudonymizer } from '@center/pii';
import { UappiOrderSchema } from '@center/connectors';
import { mapOrder } from '@center/connectors';
import { createCommerceProvider } from '../provider.js';
import { prisma, resetCommerceData, seedOrders, TEST_ORG } from './helpers/seed.js';

const CENTS = 480000;
const tenant = { organizationId: TEST_ORG, externalIds: {} };

describe('contrato de centavos — mapper da Uappi', () => {
  const pseudonymizer = new Pseudonymizer('p'.repeat(32));

  it.each([
    ['número', 4800.0],
    ['string decimal', '4800.00'],
    ['string pt-BR', '4.800,00'],
  ])('maps a total given as %s into 480000 cents', (_label, totalPedido) => {
    const parsed = UappiOrderSchema.parse({
      numeroPedido: 'PED-M1', dataEmissao: '2026-07-15 10:00:00', moeda: 'BRL',
      status: { id: 3, descricao: 'Pagamento aprovado' },
      valores: { subtotal: totalPedido, frete: 0, descontos: 0, totalPedido },
      itens: [], pagamento: [],
    });
    const { order } = mapOrder(parsed, { pseudonymizer });
    expect(order.totalCents).toBe(CENTS);
  });

  it('never lets a float reach the read model', () => {
    const parsed = UappiOrderSchema.parse({
      numeroPedido: 'PED-M2', dataEmissao: '2026-07-15 10:00:00', moeda: 'BRL',
      status: { id: 3, descricao: 'Pagamento aprovado' },
      valores: { subtotal: 0.1, frete: 0.2, descontos: 0, totalPedido: 0.3 },
      itens: [], pagamento: [],
    });
    const { order } = mapOrder(parsed, { pseudonymizer });
    // 0.1 + 0.2 em float é 0.30000000000000004; em centavos é 30.
    expect(order.subtotalCents + order.freightCents).toBe(30);
    expect(Number.isInteger(order.totalCents)).toBe(true);
  });
});

describe('contrato de centavos — provider de métricas', () => {
  beforeAll(async () => {
    await resetCommerceData();
    await seedOrders([
      { numeroPedido: 'C1', emittedAtLocal: '2026-01-10T10:00:00', statusGroup: 'PAID', totalCents: CENTS },
    ]);
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('returns revenue in cents, matching what was written', async () => {
    const series = await createCommerceProvider(prisma).query({
      metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-31',
      granularity: 'month', tenant,
    });
    expect(series.unit).toBe('currency');
    expect(series.total).toBe(CENTS);
    expect(Number.isInteger(series.total)).toBe(true);
  });

  it('returns the average ticket in cents, rounded to a whole cent', async () => {
    const series = await createCommerceProvider(prisma).query({
      metricId: 'commerce.average_ticket', from: '2026-01-01', to: '2026-01-31',
      granularity: 'month', tenant,
    });
    expect(series.total).toBe(CENTS);
    expect(Number.isInteger(series.total)).toBe(true);
  });

  it('declares every currency metric with unit "currency" — the formatter depends on it', () => {
    const provider = createCommerceProvider(prisma);
    for (const id of ['commerce.revenue', 'commerce.average_ticket']) {
      expect(provider.descriptors.find((d) => d.id === id)?.unit).toBe('currency');
    }
  });
});
