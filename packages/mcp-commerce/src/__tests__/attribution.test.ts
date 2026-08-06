import {
  createCampaignConversionTool, createCampaignRevenueTool, createChannelTicketTool,
  createDeviceRevenueTool, createReturningCustomersTool,
} from '../attribution.js';
import { prisma, resetCommerceData, seedOrders, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };
const period = { from: '2026-01-01', to: '2026-01-31', tenant };

beforeAll(async () => {
  await resetCommerceData();
  await seedOrders([
    { numeroPedido: 'A1', emittedAtLocal: '2026-01-05T10:00:00', statusGroup: 'PAID', totalCents: 30000,
      campaign: 'black-friday', device: 'mobile', canal: 'site', visitorHash: 'v1', customerExternalId: 'C1' },
    { numeroPedido: 'A2', emittedAtLocal: '2026-01-06T10:00:00', statusGroup: 'PAID', totalCents: 10000,
      campaign: 'black-friday', device: 'desktop', canal: 'site', visitorHash: 'v2', customerExternalId: 'C2' },
    { numeroPedido: 'A3', emittedAtLocal: '2026-01-07T10:00:00', statusGroup: 'DELIVERED', totalCents: 20000,
      campaign: 'natal', device: 'mobile', canal: 'app', visitorHash: 'v3', customerExternalId: 'C3' },
    // Cliente recorrente que veio de black-friday
    { numeroPedido: 'A4', emittedAtLocal: '2026-01-20T10:00:00', statusGroup: 'PAID', totalCents: 15000,
      campaign: 'black-friday', device: 'mobile', canal: 'site', visitorHash: 'v1', customerExternalId: 'C1' },
    // Cancelado: nunca conta como receita
    { numeroPedido: 'A5', emittedAtLocal: '2026-01-08T10:00:00', statusGroup: 'CANCELLED', totalCents: 99999,
      campaign: 'black-friday', device: 'mobile', visitorHash: 'v9' },
    // Sem campanha
    { numeroPedido: 'A6', emittedAtLocal: '2026-01-09T10:00:00', statusGroup: 'PAID', totalCents: 5000,
      campaign: null, device: 'desktop', canal: 'app', customerExternalId: 'C4' },
  ]);

  // 5 visitantes chegaram por black-friday; 2 deles compraram (v1, v2).
  await prisma.attributionTouch.createMany({
    data: ['v1', 'v2', 'v4', 'v5', 'v6'].map((visitorHash) => ({
      organizationId: TEST_ORG, visitorHash, campaign: 'black-friday',
      source: 'google', medium: 'cpc', device: 'mobile',
      occurredAt: new Date('2026-01-04T10:00:00Z'),
    })),
  });
});

afterAll(async () => {
  await prisma.attributionTouch.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.$disconnect();
});

describe('campaign_revenue', () => {
  const tool = createCampaignRevenueTool(prisma);

  it('ranks campaigns by revenue in cents', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows[0]).toMatchObject({ key: 'black-friday', value: 55000 });
    expect(result.rows[1]).toMatchObject({ key: 'natal', value: 20000 });
  });

  it('excludes cancelled orders', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows.find((r) => r.key === 'black-friday')?.value).toBe(55000);
  });

  it('groups orders without a campaign under a visible label', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string }> };
    expect(result.rows.map((r) => r.key)).toContain('sem-campanha');
  });

  it('reports order count and average ticket per campaign', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; extra: Record<string, number> }> };
    expect(result.rows.find((r) => r.key === 'black-friday')?.extra)
      .toMatchObject({ orders: 3, averageTicketCents: 18333 });
  });
});

describe('channel_average_ticket', () => {
  const tool = createChannelTicketTool(prisma);

  it('computes the average ticket per channel', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; value: number }> };
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    // site: (30000 + 10000 + 15000) / 3 = 18333
    expect(byKey.site).toBe(18333);
    // app: (20000 + 5000) / 2 = 12500
    expect(byKey.app).toBe(12500);
  });

  it('sorts by average ticket descending', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string }> };
    expect(result.rows[0]?.key).toBe('site');
  });
});

describe('device_revenue', () => {
  const tool = createDeviceRevenueTool(prisma);

  it('ranks devices by revenue', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; value: number }> };
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    expect(byKey.mobile).toBe(65000); // 30000 + 20000 + 15000
    expect(byKey.desktop).toBe(15000); // 10000 + 5000
  });

  it('reports the average ticket per device', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; extra: Record<string, number> }> };
    expect(result.rows.find((r) => r.key === 'desktop')?.extra.averageTicketCents).toBe(7500);
  });
});

describe('campaign_conversion', () => {
  const tool = createCampaignConversionTool(prisma);

  it('reports how many campaign visitors ended up buying', async () => {
    const result = await tool.handler({ ...period, campaign: 'black-friday' }) as Record<string, number>;
    // 5 visitantes tocados, 2 compraram (v1, v2).
    expect(result).toMatchObject({ visitors: 5, buyers: 2 });
    expect(result.conversionRate).toBeCloseTo(0.4, 5);
  });

  it('reports revenue from those visitors only', async () => {
    const result = await tool.handler({ ...period, campaign: 'black-friday' }) as Record<string, number>;
    // v1 comprou A1 (30000) e A4 (15000); v2 comprou A2 (10000).
    expect(result.revenueCents).toBe(55000);
  });

  it('does not count the cancelled order of an untouched visitor', async () => {
    const result = await tool.handler({ ...period, campaign: 'black-friday' }) as Record<string, number>;
    expect(result.buyers).toBe(2);
  });

  it('returns zeros instead of dividing by zero for an unknown campaign', async () => {
    const result = await tool.handler({ ...period, campaign: 'inexistente' }) as Record<string, number>;
    expect(result).toMatchObject({ visitors: 0, buyers: 0, conversionRate: 0, revenueCents: 0 });
  });

  it('never exposes a visitor hash in the response', async () => {
    const result = await tool.handler({ ...period, campaign: 'black-friday' });
    expect(JSON.stringify(result)).not.toContain('v1');
  });
});

describe('campaign_returning_customers', () => {
  const tool = createReturningCustomersTool(prisma);

  it('counts customers with more than one order per campaign', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; extra: Record<string, number> }> };
    const bf = result.rows.find((r) => r.key === 'black-friday');
    // C1 comprou duas vezes; C2 uma.
    expect(bf?.extra).toMatchObject({ customers: 2, returningCustomers: 1 });
  });

  it('reports the returning rate', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows.find((r) => r.key === 'black-friday')?.value).toBeCloseTo(0.5, 5);
  });

  it('sorts by returning rate descending', async () => {
    const result = await tool.handler(period) as { rows: Array<{ value: number }> };
    const values = result.rows.map((r) => r.value);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });
});
