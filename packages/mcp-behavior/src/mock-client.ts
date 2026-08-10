import type { BigQueryEventsClientLike } from './interface.js';

/**
 * Fixture de `events_before_purchase` (T36) — quebra de eventos que precedem
 * uma compra (`buildPurchasePathSql`). Não carrega mais um campo `purchases`:
 * a query real que ela representa (`PurchasePathRow`) nunca leu esse campo —
 * o total de compradores vem de uma query separada, `buildTotalBuyersSql`
 * (ver `FIXTURE_TOTAL_BUYERS_ROW` abaixo). Mantê-lo aqui seria dado morto que
 * nenhum código de produção olha.
 */
export const FIXTURE_PURCHASE_PATH_ROWS = [
  { event_name: 'page_view', users: 500, avg_position: 5.6 },
  { event_name: 'view_item', users: 480, avg_position: 3.2 },
  { event_name: 'add_to_cart', users: 410, avg_position: 2.1 },
  { event_name: 'begin_checkout', users: 350, avg_position: 1.4 },
  { event_name: 'add_payment_info', users: 320, avg_position: 1.1 },
];

/**
 * Fixture da query de total de compradores (`buildTotalBuyersSql`) —
 * independente da quebra de eventos acima (ver comentário em
 * `buildTotalBuyersSql` sobre por que as duas queries são separadas). 500
 * casa com o maior valor de `users` em `FIXTURE_PURCHASE_PATH_ROWS`
 * (`page_view`), contando a história plausível de que todo comprador viu ao
 * menos a página antes de comprar.
 */
export const FIXTURE_TOTAL_BUYERS_ROW = { buyers: 500 };

/** Fixture de `screen_abandon_impact` (T37) — quem viu a tela compra menos. */
export const FIXTURE_SCREEN_IMPACT_ROWS = [
  { saw_screen: true, users: 300, buyers: 45 },
  { saw_screen: false, users: 700, buyers: 210 },
];

/**
 * Nunca toca o BigQuery. `events_before_purchase` (T36) dispara duas
 * consultas independentes com a mesma forma de parâmetros nomeados
 * (`{ fromCompact, toCompact }`) — presença de chave não basta para
 * distingui-las, então a query de total de compradores é identificada pela
 * assinatura da sua SQL (`AS buyers`, o mesmo sinal usado no client falso de
 * `purchase-path.test.ts`). `screen_abandon_impact` (T37) é a única que envia
 * `screenName`, então essa chave ainda basta para escolhê-la primeiro. Se uma
 * quarta consulta for adicionada depois, este `if` cresce em um branch — não
 * em complexidade.
 */
export class MockBigQueryEventsClient implements BigQueryEventsClientLike {
  async query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
    if ('screenName' in params) {
      return FIXTURE_SCREEN_IMPACT_ROWS as unknown as T[];
    }
    if (sql.includes('AS buyers')) {
      return [FIXTURE_TOTAL_BUYERS_ROW] as unknown as T[];
    }
    return FIXTURE_PURCHASE_PATH_ROWS as unknown as T[];
  }
}
