const GRAPH_VERSION = 'v21.0';

export interface CloudApiCredentials {
  accessToken: string;
  phoneNumberId: string;
}

export class CloudApiClient {
  constructor(
    private readonly credentials: CloudApiCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText(toPhoneE164: string, body: string): Promise<void> {
    const response = await this.fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${this.credentials.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.credentials.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toPhoneE164,
          type: 'text',
          // preview_url: false evita que a Meta expanda links da resposta.
          text: { preview_url: false, body },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(payload?.error?.message ?? `WhatsApp Cloud API respondeu ${response.status}`);
    }
  }
}
