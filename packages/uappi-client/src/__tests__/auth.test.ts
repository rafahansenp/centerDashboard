import { UappiTokenProvider } from '../auth.js';

const credentials = { apiKey: 'ak', secretKey: 'sk' };

function buildProvider(fetchImpl: jest.Mock, now: () => number = () => 0) {
  return new UappiTokenProvider({
    baseUrl: 'https://api.uappi.com.br',
    credentials,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now,
  });
}

function tokenResponse(token: string) {
  return new Response(JSON.stringify({ token }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

describe('UappiTokenProvider', () => {
  it('posts the credentials to /v2/auth with the App-Token header', async () => {
    const fetchImpl = jest.fn(async () => tokenResponse('jwt-1'));
    expect(await buildProvider(fetchImpl).getToken()).toBe('jwt-1');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.uappi.com.br/v2/auth');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['App-Token']).toBe('wapstore');
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: 'ak', secretKey: 'sk' });
  });

  it('reuses the cached token instead of authenticating again', async () => {
    const fetchImpl = jest.fn(async () => tokenResponse('jwt-1'));
    const provider = buildProvider(fetchImpl);
    await provider.getToken();
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('renews the token before the 30 minute expiry', async () => {
    let currentTime = 0;
    const fetchImpl = jest.fn(async () => tokenResponse(`jwt-${fetchImpl.mock.calls.length}`));
    const provider = buildProvider(fetchImpl, () => currentTime);

    await provider.getToken();
    currentTime = 24 * 60_000; // 24 min — ainda dentro da margem
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    currentTime = 26 * 60_000; // passou dos 25 min de margem
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('authenticates only once when many callers race for the token', async () => {
    const fetchImpl = jest.fn(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      return tokenResponse('jwt-1');
    });
    const provider = buildProvider(fetchImpl);
    const tokens = await Promise.all([
      provider.getToken(), provider.getToken(), provider.getToken(),
    ]);
    expect(tokens).toEqual(['jwt-1', 'jwt-1', 'jwt-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-authenticates after invalidate', async () => {
    const fetchImpl = jest.fn(async () => tokenResponse(`jwt-${fetchImpl.mock.calls.length}`));
    const provider = buildProvider(fetchImpl);
    await provider.getToken();
    provider.invalidate();
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws a readable error when the credentials are rejected', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      JSON.stringify({ message: 'apiKey inválida' }), { status: 401 },
    ));
    await expect(buildProvider(fetchImpl).getToken())
      .rejects.toThrow('autenticação na Uappi falhou (401): apiKey inválida');
  });

  it('does not cache a failed authentication', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(tokenResponse('jwt-1'));
    const provider = buildProvider(fetchImpl);
    await expect(provider.getToken()).rejects.toThrow();
    expect(await provider.getToken()).toBe('jwt-1');
  });

  it('falls back to the global fetch and Date.now when no deps are injected', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse('jwt-1'));
    try {
      const provider = new UappiTokenProvider({ baseUrl: 'https://api.uappi.com.br', credentials });
      expect(await provider.getToken()).toBe('jwt-1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
