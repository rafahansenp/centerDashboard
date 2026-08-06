import { RateLimiter } from '../rate-limiter.js';
import { UappiClient, UappiApiError } from '../client.js';
import { UappiTokenProvider } from '../auth.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function page(pedidos: unknown[], total: number, offset: number, limit: number) {
  return { pedidos, info: { offset, limit, total, exibindo: pedidos.length } };
}

function buildClient(fetchImpl: jest.Mock) {
  const tokenProvider = {
    getToken: jest.fn(async () => 'jwt-1'),
    invalidate: jest.fn(),
  } as unknown as UappiTokenProvider;

  // Limitadores sem espera: o comportamento de espera já é testado em rate-limiter.test.
  const noWait = new RateLimiter(1000, () => 0, async () => {});

  return {
    client: new UappiClient({
      baseUrl: 'https://api.uappi.com.br',
      tokenProvider,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      listLimiter: noWait,
      detailLimiter: noWait,
    }),
    tokenProvider,
  };
}

describe('UappiClient.listOrders', () => {
  it('sends both required headers', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([], 0, 0, 100)));
    await buildClient(fetchImpl).client.listOrders({
      from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100,
    });
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['App-Token']).toBe('wapstore');
    expect(headers.Authorization).toBe('Bearer jwt-1');
  });

  it('encodes the date range with the pipe separator Uappi expects', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([], 0, 0, 100)));
    await buildClient(fetchImpl).client.listOrders({
      from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100,
    });
    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/v2/orders');
    expect(url.searchParams.get('dataEmissao')).toBe('2026-01-01|2026-01-31');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('caps the limit at the documented maximum of 100', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([], 0, 0, 100)));
    await buildClient(fetchImpl).client.listOrders({
      from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 500,
    });
    expect(new URL(fetchImpl.mock.calls[0]![0] as string).searchParams.get('limit')).toBe('100');
  });

  it('forwards an optional status filter', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([], 0, 0, 100)));
    await buildClient(fetchImpl).client.listOrders({
      from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100, status: 'cancelado',
    });
    expect(new URL(fetchImpl.mock.calls[0]![0] as string).searchParams.get('status')).toBe('cancelado');
  });

  it('returns the parsed page', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([{ numeroPedido: '1' }], 1, 0, 100)));
    const result = await buildClient(fetchImpl).client.listOrders({
      from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100,
    });
    expect(result.info.total).toBe(1);
    expect(result.pedidos).toHaveLength(1);
  });

  it('invalidates the token and retries once on 401', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'token expirado' }, 401))
      .mockResolvedValueOnce(jsonResponse(page([], 0, 0, 100)));
    const { client, tokenProvider } = buildClient(fetchImpl);

    await client.listOrders({ from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100 });
    expect(tokenProvider.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after a second 401 instead of looping', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ message: 'sem permissão' }, 401));
    await expect(
      buildClient(fetchImpl).client.listOrders({
        from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100,
      }),
    ).rejects.toBeInstanceOf(UappiApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws UappiApiError carrying the status on 429', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ message: 'rate limit' }, 429));
    await expect(
      buildClient(fetchImpl).client.listOrders({
        from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100,
      }),
    ).rejects.toMatchObject({ name: 'UappiApiError', status: 429 });
  });
});

describe('UappiClient.getOrder', () => {
  it('requests the order detail path', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ numeroPedido: 'PED-1' }));
    await buildClient(fetchImpl).client.getOrder('PED-1');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.uappi.com.br/v2/orders/PED-1');
  });

  it('url-encodes an order number with special characters', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}));
    await buildClient(fetchImpl).client.getOrder('PED/2026 1');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.uappi.com.br/v2/orders/PED%2F2026%201');
  });
});

describe('UappiClient.iterateOrders', () => {
  it('walks every page until the total is reached', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse(page([{ n: 1 }, { n: 2 }], 5, 0, 2)))
      .mockResolvedValueOnce(jsonResponse(page([{ n: 3 }, { n: 4 }], 5, 2, 2)))
      .mockResolvedValueOnce(jsonResponse(page([{ n: 5 }], 5, 4, 2)));

    const collected: unknown[] = [];
    for await (const batch of buildClient(fetchImpl).client.iterateOrders({
      from: '2026-01-01', to: '2026-01-31', pageSize: 2,
    })) {
      collected.push(...batch);
    }
    expect(collected).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops on an empty page even if the total disagrees', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse(page([{ n: 1 }], 999, 0, 2)))
      .mockResolvedValueOnce(jsonResponse(page([], 999, 2, 2)));

    const collected: unknown[] = [];
    for await (const batch of buildClient(fetchImpl).client.iterateOrders({
      from: '2026-01-01', to: '2026-01-31', pageSize: 2,
    })) {
      collected.push(...batch);
    }
    expect(collected).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('yields nothing when the range has no orders', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([], 0, 0, 100)));
    const batches: unknown[][] = [];
    for await (const batch of buildClient(fetchImpl).client.iterateOrders({
      from: '2026-01-01', to: '2026-01-31', pageSize: 100,
    })) {
      batches.push(batch);
    }
    expect(batches).toEqual([]);
  });
});
