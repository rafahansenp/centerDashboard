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

  it('reports total as the overall average ticket, not the sum of per-channel averages, and omits share (B1)', async () => {
    const result = await tool.handler(period) as {
      total: number; rows: Array<{ key: string; value: number; share?: number }>;
    };
    // Somar 18333 (site) + 12500 (app) daria ~30833, sem significado.
    // O correto é receita total / pedidos totais do período inteiro:
    // (30000+10000+15000+20000+5000) / 5 = 16000.
    expect(result.total).toBe(16000);
    expect(result.rows.every((r) => r.share === undefined)).toBe(true);
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

describe('campaign_conversion — touched respeita as duas pontas do período (B3)', () => {
  const tool = createCampaignConversionTool(prisma);
  const b3Period = { from: '2026-05-01', to: '2026-05-31', tenant };

  beforeAll(async () => {
    // v-antigo tocou a campanha ANTES do período (abril) e nunca comprou.
    // Sob o bug B3 (touched sem limite inferior), esse toque de abril ainda
    // seria contado como "visitante" da consulta de maio.
    await prisma.attributionTouch.create({
      data: {
        organizationId: TEST_ORG, visitorHash: 'v-antigo', campaign: 'campanha-de-maio',
        source: 'google', medium: 'cpc', device: 'mobile',
        occurredAt: new Date('2026-04-15T10:00:00Z'),
      },
    });
    // v-maio tocou e comprou dentro de maio — deve contar normalmente.
    await prisma.attributionTouch.create({
      data: {
        organizationId: TEST_ORG, visitorHash: 'v-maio', campaign: 'campanha-de-maio',
        source: 'google', medium: 'cpc', device: 'mobile',
        occurredAt: new Date('2026-05-05T10:00:00Z'),
      },
    });
    await seedOrders([
      { numeroPedido: 'B3-1', emittedAtLocal: '2026-05-10T10:00:00', statusGroup: 'PAID', totalCents: 5000,
        visitorHash: 'v-maio' },
    ]);
  });

  it('does not count a touch from before the period as a visitor', async () => {
    const result = await tool.handler({ ...b3Period, campaign: 'campanha-de-maio' }) as { visitors: number; buyers: number };
    // Só v-maio deveria contar; v-antigo tocou em abril, fora da janela.
    expect(result.visitors).toBe(1);
    expect(result.buyers).toBe(1);
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

describe('campaign_returning_customers — pedidos sem cliente vinculado', () => {
  const tool = createReturningCustomersTool(prisma);
  const guestPeriod = { from: '2026-03-01', to: '2026-03-31', tenant };

  beforeAll(async () => {
    // Pedido de visitante: sem customerExternalId, customerId fica null no banco.
    await seedOrders([
      { numeroPedido: 'G1', emittedAtLocal: '2026-03-05T10:00:00', statusGroup: 'PAID', totalCents: 10000,
        campaign: 'sem-cliente' },
    ]);
  });

  it('reports zero customers and zero rate, and no share, for a group made only of guest checkouts', async () => {
    const result = await tool.handler(guestPeriod) as {
      total: number; rows: Array<{ key: string; value: number; share?: number; extra: Record<string, number> }>;
    };
    const row = result.rows.find((r) => r.key === 'sem-cliente');
    expect(row?.extra.customers).toBe(0);
    expect(row?.value).toBe(0);
    // Rate não é aditiva entre campanhas: share nunca é reportado por linha.
    expect(row?.share).toBeUndefined();
    // Único grupo do período, com taxa 0 — o total agregado (correto, não somado) também é 0.
    expect(result.total).toBe(0);
  });
});

describe('campaign_returning_customers — total é a taxa geral, não a soma das linhas (B1)', () => {
  const tool = createReturningCustomersTool(prisma);
  const b1Period = { from: '2026-04-01', to: '2026-04-30', tenant };

  beforeAll(async () => {
    // campanha-a: 2 clientes, 1 recorrente → taxa 0,5
    await seedOrders([
      { numeroPedido: 'B1-1', emittedAtLocal: '2026-04-05T10:00:00', statusGroup: 'PAID', totalCents: 1000,
        campaign: 'campanha-a', customerExternalId: 'CA1' },
      { numeroPedido: 'B1-2', emittedAtLocal: '2026-04-06T10:00:00', statusGroup: 'PAID', totalCents: 1000,
        campaign: 'campanha-a', customerExternalId: 'CA1' },
      { numeroPedido: 'B1-3', emittedAtLocal: '2026-04-07T10:00:00', statusGroup: 'PAID', totalCents: 1000,
        campaign: 'campanha-a', customerExternalId: 'CA2' },
      // campanha-b: 2 clientes, nenhum recorrente → taxa 0
      { numeroPedido: 'B1-4', emittedAtLocal: '2026-04-08T10:00:00', statusGroup: 'PAID', totalCents: 1000,
        campaign: 'campanha-b', customerExternalId: 'CB1' },
      { numeroPedido: 'B1-5', emittedAtLocal: '2026-04-09T10:00:00', statusGroup: 'PAID', totalCents: 1000,
        campaign: 'campanha-b', customerExternalId: 'CB2' },
    ]);
  });

  it('computes total as the overall recurrence rate, not the sum of each row', async () => {
    const result = await tool.handler(b1Period) as {
      total: number; rows: Array<{ key: string; value: number; share?: number }>;
    };
    // Somar as taxas daria 0,5 + 0 = 0,5. A taxa geral correta é
    // 1 cliente recorrente / 4 clientes totais = 0,25.
    expect(result.total).toBeCloseTo(0.25, 5);
    // share nunca é reportado por linha — taxa não é aditiva entre campanhas.
    expect(result.rows.every((r) => r.share === undefined)).toBe(true);
  });
});
