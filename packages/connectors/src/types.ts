import type { Pseudonymizer } from '@center/pii';
import type { MappedOrder, MappedOrderItem } from './uappi/mapper.js';

export type { MappedOrder, MappedOrderItem };

export type CommerceProvider = 'UAPPI';

/** Janela de datas inclusiva, no formato YYYY-MM-DD. */
export interface DateWindow {
  from: string;
  to: string;
}

export interface ReadContext {
  pseudonymizer: Pseudonymizer;
  logger: (message: string, meta?: Record<string, unknown>) => void;
}

/** Pedido já canônico e pseudonimizado — nenhum dado pessoal em claro. */
export interface CanonicalOrderRecord {
  kind: 'order';
  order: MappedOrder;
  items: MappedOrderItem[];
}

/** Um pedido problemático vira falha contada, nunca interrompe a leitura. */
export interface ReadFailure {
  kind: 'failure';
  reference: string;
  error: string;
}

export type CheckResult = { ok: true } | { ok: false; error: string };

export interface CommerceConnector<TSettings = unknown> {
  provider: CommerceProvider;
  /** Valida config + segredos já decifrados; lança ZodError se inválidos. */
  parseSettings(config: unknown, secrets: unknown): TSettings;
  check(settings: TSettings): Promise<CheckResult>;
  discover(): readonly ['orders'];
  readOrders(
    settings: TSettings,
    window: DateWindow,
    ctx: ReadContext,
  ): AsyncIterable<CanonicalOrderRecord | ReadFailure>;
}
