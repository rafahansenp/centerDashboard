import { MAX_PAGE_SIZE } from '../client.js';
import { FIXTURE_ORDER_NUMBERS } from '../__fixtures__/orders.fixture.js';
import { MockUappiClient } from '../mock-client.js';

describe('MockUappiClient.listOrders', () => {
  it('returns a page shaped exactly like the real API', async () => {
    const client = new MockUappiClient();
    const page = await client.listOrders({ from: '2026-01-01', to: '2026-12-31', offset: 0, limit: 5 });
    expect(page.pedidos).toHaveLength(5);
    expect(page.info).toMatchObject({ offset: 0, limit: 5, total: FIXTURE_ORDER_NUMBERS.length });
  });

  it('filters by the dataEmissao range', async () => {
    const client = new MockUappiClient();
    const page = await client.listOrders({ from: '2026-07-01', to: '2026-07-01', offset: 0, limit: 100 });
    expect(page.pedidos).toHaveLength(1);
  });

  it('caps the limit at MAX_PAGE_SIZE, same as the real client', async () => {
    const client = new MockUappiClient();
    const page = await client.listOrders({ from: '2026-01-01', to: '2026-12-31', offset: 0, limit: 500 });
    expect(page.info.limit).toBe(MAX_PAGE_SIZE);
  });

  it('returns an empty page past the end of the fixture', async () => {
    const client = new MockUappiClient();
    const page = await client.listOrders({
      from: '2026-01-01', to: '2026-12-31', offset: FIXTURE_ORDER_NUMBERS.length, limit: 10,
    });
    expect(page.pedidos).toEqual([]);
  });
});

describe('MockUappiClient.getOrder', () => {
  it('returns the full fixture order by its natural key', async () => {
    const order = await new MockUappiClient().getOrder('PED-0001') as { numeroPedido: string };
    expect(order.numeroPedido).toBe('PED-0001');
  });

  it('throws UappiApiError-like 404 for an unknown order number', async () => {
    await expect(new MockUappiClient().getOrder('PED-INEXISTENTE')).rejects.toThrow('404');
  });
});

describe('MockUappiClient.iterateOrders', () => {
  it('walks every fixture order across pages', async () => {
    const client = new MockUappiClient();
    const collected: unknown[] = [];
    for await (const batch of client.iterateOrders({ from: '2026-01-01', to: '2026-12-31', pageSize: 3 })) {
      collected.push(...batch);
    }
    expect(collected).toHaveLength(FIXTURE_ORDER_NUMBERS.length);
  });
});
