export type OrderStatusGroup =
  | 'PAID' | 'PENDING_PAYMENT' | 'PROCESSING' | 'SHIPPED'
  | 'DELIVERED' | 'CANCELLED' | 'FAILED' | 'OTHER';

const VALID_GROUPS = new Set<string>([
  'PAID', 'PENDING_PAYMENT', 'PROCESSING', 'SHIPPED',
  'DELIVERED', 'CANCELLED', 'FAILED', 'OTHER',
]);

/**
 * A ORDEM IMPORTA — o primeiro padrão que casa vence.
 *
 * Cancelamento e falha vêm antes de "pago" de propósito: um status como
 * "Cancelado após pagamento aprovado" contém as duas palavras, e contá-lo como
 * venda inflaria o faturamento. Erro de faturamento para cima é o pior tipo.
 */
export const DEFAULT_STATUS_PATTERNS: Array<{ group: OrderStatusGroup; pattern: RegExp }> = [
  { group: 'CANCELLED', pattern: /cancel/ },
  { group: 'FAILED', pattern: /recusad|nao autorizad|negad|estornad|falh|chargeback/ },
  { group: 'DELIVERED', pattern: /entregue/ },
  { group: 'SHIPPED', pattern: /enviad|transporte|despachad|em rota|saiu para entrega/ },
  { group: 'PENDING_PAYMENT', pattern: /aguardando (pagamento|pgto)|pendente de pagamento|aguardando pgto/ },
  { group: 'PAID', pattern: /\bpago\b|pagamento (aprovad|confirmad)|aprovad|faturad/ },
  { group: 'PROCESSING', pattern: /separacao|processamento|em producao|preparando|conferencia/ },
];

function normalize(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Traduz o status configurável da loja num grupo perguntável.
 *
 * `overrides` vem de `Organization.statusMapping` e mapeia `idStatus` → grupo.
 * Existe porque nenhum conjunto de padrões cobre todas as lojas, e a alternativa
 * — pedir ao cliente para renomear os status dele — não é uma alternativa.
 */
export function resolveStatusGroup(
  statusId: number,
  statusLabel: string,
  overrides?: Record<string, string> | null,
): OrderStatusGroup {
  const override = overrides?.[String(statusId)];
  if (override && VALID_GROUPS.has(override)) {
    return override as OrderStatusGroup;
  }

  const normalized = normalize(statusLabel);
  for (const { group, pattern } of DEFAULT_STATUS_PATTERNS) {
    if (pattern.test(normalized)) return group;
  }
  return 'OTHER';
}
