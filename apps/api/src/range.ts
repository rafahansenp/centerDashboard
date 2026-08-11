/**
 * Teto de intervalo compartilhado por toda consulta que aceita `from`/`to` —
 * HTTP (`routes/metrics.ts`, `routes/analysis.ts`) e o agente de WhatsApp
 * (`agent/tools.ts`). Um único lugar para a constante e a validação: uma
 * segunda cópia de um limite de segurança é exatamente como as duas cópias
 * divergem (uma rota ganha o teto, a outra fica esquecida).
 *
 * BigQuery é protegido separadamente por `maximumBytesBilled`, mas o Postgres
 * (pedidos/itens de pedido do commerce) não tem equivalente — este teto é a
 * única defesa contra um `from`/`to` de décadas varrendo a tabela inteira.
 */
export const MAX_RANGE_DAYS = 400;

export class BadRequestError extends Error {}

export function assertRange(range: { from: string; to: string }): void {
  if (range.from > range.to) {
    throw new BadRequestError(`"from" (${range.from}) é anterior a "to" (${range.to})`);
  }
  const spanDays =
    (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new BadRequestError(`intervalo excede o máximo de ${MAX_RANGE_DAYS} dias`);
  }
}

function isDateRange(value: unknown): value is { from: string; to: string } {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as Record<string, unknown>).from === 'string' &&
    typeof (value as Record<string, unknown>).to === 'string'
  );
}

/**
 * Aplica `assertRange` a qualquer par from/to presente no corpo de uma
 * chamada de ferramenta — seja no nível raiz (`{ from, to }`, a forma usada
 * pela maioria das ferramentas) ou aninhado em `periodA`/`periodB` (a forma
 * usada por `compare_products`/`compare_events`, ver
 * `packages/mcp-commerce/src/rankings.ts`). Sem isto, ferramentas de
 * comparação nunca passavam pelo teto de dias, apesar de fazerem os mesmos
 * joins sobre `CommerceOrderItem`/`CommerceOrder` que as demais.
 */
export function assertRangesInBody(body: Record<string, unknown>): void {
  if (isDateRange(body)) assertRange(body);
  if (isDateRange(body.periodA)) assertRange(body.periodA);
  if (isDateRange(body.periodB)) assertRange(body.periodB);
}
