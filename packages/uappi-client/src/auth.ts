import { z } from 'zod';

const APP_TOKEN = 'wapstore';
const TOKEN_LIFETIME_MS = 30 * 60_000;
/** Renovamos aos 25 min: 5 min de folga cobrem clock skew e requisições em voo. */
const RENEW_MARGIN_MS = 5 * 60_000;

const AuthResponseSchema = z.object({ token: z.string().min(1) });

export interface UappiCredentials {
  apiKey: string;
  secretKey: string;
}

export interface TokenProviderDeps {
  baseUrl: string;
  credentials: UappiCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Cacheia o JWT da Uappi e o renova antes de expirar.
 *
 * A promessa em voo é compartilhada entre chamadores concorrentes: durante o
 * backfill dezenas de requisições descobrem o token vencido ao mesmo tempo, e
 * sem isso todas autenticariam em paralelo — estourando o limite de 30 req/min
 * do próprio endpoint de auth.
 */
export class UappiTokenProvider {
  private token: string | null = null;
  private issuedAt = 0;
  private inFlight: Promise<string> | null = null;

  private readonly baseUrl: string;
  private readonly credentials: UappiCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(deps: TokenProviderDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.credentials = deps.credentials;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    if (this.token && this.now() - this.issuedAt < TOKEN_LIFETIME_MS - RENEW_MARGIN_MS) {
      return this.token;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.authenticate();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  invalidate(): void {
    this.token = null;
    this.issuedAt = 0;
  }

  private async authenticate(): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v2/auth`, {
      method: 'POST',
      headers: { 'App-Token': APP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(this.credentials),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(
        `autenticação na Uappi falhou (${response.status})${body?.message ? `: ${body.message}` : ''}`,
      );
    }

    const { token } = AuthResponseSchema.parse(await response.json());
    this.token = token;
    this.issuedAt = this.now();
    return token;
  }
}
