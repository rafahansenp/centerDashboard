import { z } from 'zod';
import { RateLimiter } from './rate-limiter.js';
import type { UappiTokenProvider } from './auth.js';
import type { UappiClientLike } from './interface.js';

const APP_TOKEN = 'wapstore';
/** Documentado como máximo por página. */
export const MAX_PAGE_SIZE = 100;
/** Limites publicados na documentação da Uappi. */
export const LIST_ORDERS_PER_MINUTE = 120;
export const ORDER_DETAIL_PER_MINUTE = 60;

export class UappiApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'UappiApiError';
  }
}

const ListOrdersPageSchema = z.object({
  pedidos: z.array(z.unknown()).default([]),
  info: z.object({
    offset: z.coerce.number(),
    limit: z.coerce.number(),
    total: z.coerce.number(),
    exibindo: z.coerce.number(),
  }),
});
export type ListOrdersPage = z.infer<typeof ListOrdersPageSchema>;

export interface ListOrdersParams {
  from: string;
  to: string;
  offset: number;
  limit: number;
  status?: string;
}

export interface IterateOrdersParams {
  from: string;
  to: string;
  pageSize?: number;
  status?: string;
}

export interface UappiClientOptions {
  baseUrl: string;
  tokenProvider: UappiTokenProvider;
  fetchImpl?: typeof fetch;
  listLimiter?: RateLimiter;
  detailLimiter?: RateLimiter;
}

export class UappiClient implements UappiClientLike {
  private readonly baseUrl: string;
  private readonly tokenProvider: UappiTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly listLimiter: RateLimiter;
  private readonly detailLimiter: RateLimiter;

  constructor(options: UappiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.listLimiter = options.listLimiter ?? new RateLimiter(LIST_ORDERS_PER_MINUTE);
    this.detailLimiter = options.detailLimiter ?? new RateLimiter(ORDER_DETAIL_PER_MINUTE);
  }

  /**
   * Um 401 no meio de um backfill longo quase sempre significa token vencido —
   * invalidamos e tentamos uma única vez. Uma segunda falha é credencial ou
   * permissão, e repetir não resolveria.
   */
  private async request(url: string, limiter: RateLimiter): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await limiter.acquire();
      const token = await this.tokenProvider.getToken();

      const response = await this.fetchImpl(url, {
        headers: {
          'App-Token': APP_TOKEN,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) return response.json();

      if (response.status === 401 && attempt === 0) {
        this.tokenProvider.invalidate();
        continue;
      }

      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new UappiApiError(
        response.status,
        `Uappi respondeu ${response.status} em ${new URL(url).pathname}${
          body?.message ? `: ${body.message}` : ''
        }`,
      );
    }
    throw new UappiApiError(401, 'autenticação na Uappi falhou após renovar o token');
  }

  async listOrders(params: ListOrdersParams): Promise<ListOrdersPage> {
    const url = new URL('/v2/orders', this.baseUrl);
    url.searchParams.set('offset', String(params.offset));
    url.searchParams.set('limit', String(Math.min(params.limit, MAX_PAGE_SIZE)));
    // A Uappi espera o range separado por pipe: 2026-01-01|2026-01-31.
    url.searchParams.set('dataEmissao', `${params.from}|${params.to}`);
    if (params.status) url.searchParams.set('status', params.status);

    return ListOrdersPageSchema.parse(await this.request(url.toString(), this.listLimiter));
  }

  getOrder(numeroPedido: string): Promise<unknown> {
    const url = `${this.baseUrl}/v2/orders/${encodeURIComponent(numeroPedido)}`;
    return this.request(url, this.detailLimiter);
  }

  /**
   * Percorre todas as páginas do range. Para numa página vazia mesmo que o
   * `total` diga o contrário — vimos APIs reportarem total inconsistente, e um
   * laço infinito num backfill é pior do que perder a última página.
   */
  async *iterateOrders(params: IterateOrdersParams): AsyncGenerator<unknown[]> {
    const pageSize = Math.min(params.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    let offset = 0;

    for (;;) {
      const page = await this.listOrders({
        from: params.from,
        to: params.to,
        offset,
        limit: pageSize,
        ...(params.status ? { status: params.status } : {}),
      });

      if (page.pedidos.length === 0) return;
      yield page.pedidos;

      offset += page.pedidos.length;
      if (offset >= page.info.total) return;
    }
  }
}
