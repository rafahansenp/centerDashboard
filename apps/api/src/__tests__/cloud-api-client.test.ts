import { CloudApiClient } from '../whatsapp/cloud-api-client.js';

function buildClient(fetchImpl: jest.Mock) {
  return new CloudApiClient(
    { accessToken: 'token-abc', phoneNumberId: '123456' },
    fetchImpl as unknown as typeof fetch,
  );
}

describe('CloudApiClient.sendText', () => {
  it('posts to the graph messages endpoint of the phone number', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 200 }));
    await buildClient(fetchImpl).sendText('+5511988887777', 'olá');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/123456/messages');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-abc');
  });

  it('sends the documented text message body', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 200 }));
    await buildClient(fetchImpl).sendText('+5511988887777', 'olá');
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to: '+5511988887777', type: 'text', text: { preview_url: false, body: 'olá' },
    });
  });

  it('throws with the graph error message on failure', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Recipient phone number not in allowed list', code: 131030 } }),
      { status: 400 },
    ));
    await expect(buildClient(fetchImpl).sendText('+5511988887777', 'olá'))
      .rejects.toThrow('Recipient phone number not in allowed list');
  });

  it('throws a readable error when the body is not json', async () => {
    const fetchImpl = jest.fn(async () => new Response('<html>502</html>', { status: 502 }));
    await expect(buildClient(fetchImpl).sendText('+5511988887777', 'olá')).rejects.toThrow(/502/);
  });
});
