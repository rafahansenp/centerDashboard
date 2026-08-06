import { toCents } from '@center/shared';
import type { Pseudonymizer } from '@center/pii';
import type { UappiOrder } from './schemas.js';
import { resolveStatusGroup, type OrderStatusGroup } from './status-map.js';

const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';
/** Offset fixo do Brasil desde 2019 — o horário de verão foi extinto. */
const SAO_PAULO_OFFSET = '-03:00';

const SKU_PLACEHOLDER = 'SEM-SKU';

export interface MappedCustomer {
  externalId: string;
  emailHash: string | null;
  documentHash: string | null;
}

export interface MappedAttribution {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  device: string | null;
  visitorHash: string | null;
}

export interface MappedOrderItem {
  sku: string;
  productName: string;
  categoryName: string | null;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
}

export interface MappedOrder {
  numeroPedido: string;
  idPedido: string;
  statusLabel: string;
  statusId: number;
  statusGroup: OrderStatusGroup;
  canal: string | null;
  origem: string | null;
  tipoVenda: string | null;
  emittedAt: Date;
  subtotalCents: number;
  freightCents: number;
  discountCents: number;
  totalCents: number;
  currency: string;
  paymentMethod: string | null;
  customer: MappedCustomer | null;
  attribution: MappedAttribution;
  rawPayload: unknown;
}

export interface MapOrderDeps {
  pseudonymizer: Pseudonymizer;
  statusOverrides?: Record<string, string> | null;
}

/**
 * A Uappi devolve `dataEmissao` como "YYYY-MM-DD HH:mm:ss" sem timezone, no
 * horário local da loja. Interpretar isso como UTC jogaria pedidos da noite para
 * o dia seguinte e faria "quanto vendemos hoje" mentir na virada.
 */
export function parseUappiDate(raw: string): Date {
  const trimmed = raw.trim();

  // Já traz offset ou Z: confiamos no valor.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) throw new Error(`dataEmissao inválida: "${raw}"`);
    return parsed;
  }

  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/);
  if (!match) throw new Error(`dataEmissao inválida: "${raw}"`);

  const time = match[2] ?? '00:00:00';
  const withSeconds = time.length === 5 ? `${time}:00` : time;
  const parsed = new Date(`${match[1]}T${withSeconds}${SAO_PAULO_OFFSET}`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`dataEmissao inválida: "${raw}"`);
  return parsed;
}

function readString(bag: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  if (!bag) return null;
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** Campanha e origem viram minúsculas para não fragmentar o agrupamento. */
function normalizeTag(value: string | null): string | null {
  return value === null ? null : value.toLowerCase();
}

function mapCustomer(order: UappiOrder, pseudonymizer: Pseudonymizer): MappedCustomer | null {
  const customer = order.cliente;
  if (!customer || customer.idCliente === undefined) return null;

  const email = typeof customer.email === 'string' ? customer.email.trim() : '';
  const document = typeof customer.documento === 'string' ? customer.documento.trim() : '';

  return {
    externalId: String(customer.idCliente),
    // Só hash. Não existe caminho neste arquivo que devolva o valor original.
    emailHash: email !== '' ? pseudonymizer.hashEmail(email) : null,
    documentHash: document.replace(/\D/g, '') !== '' ? pseudonymizer.hashDocument(document) : null,
  };
}

const PII_REDACTED = '[REDACTED]';
const CUSTOMER_PII_KEYS = ['email', 'documento', 'nomeRazao'] as const;

/**
 * `rawPayload` guarda o pedido inteiro para reprocessamento offline, mas
 * `order.cliente` (schema `.passthrough()`) carrega e-mail, documento e
 * razão social em claro — dado pessoal que não pode ir para o banco. Devolve
 * uma cópia do pedido com só esses três campos redigidos; tudo o mais
 * (itens, valores, status, pagamento, informacoesAdicionais e os demais
 * campos de `cliente`, como `idCliente`) permanece intacto para reprocessamento.
 * Não muta `order`: quem já leu `order.cliente.email`/`documento` para hash
 * continua vendo os valores reais.
 */
function redactRawPayload(order: UappiOrder): unknown {
  const customer = order.cliente as Record<string, unknown> | undefined;
  if (!customer) return order;

  const redactedCustomer: Record<string, unknown> = { ...customer };
  for (const key of CUSTOMER_PII_KEYS) {
    if (key in redactedCustomer) redactedCustomer[key] = PII_REDACTED;
  }

  return { ...order, cliente: redactedCustomer };
}

function mapAttribution(order: UappiOrder, pseudonymizer: Pseudonymizer): MappedAttribution {
  const extra = order.informacoesAdicionais as Record<string, unknown> | undefined;
  const visitorId = readString(extra, 'centerVisitorId', 'center_visitor_id', 'clientId', 'client_id');

  return {
    source: normalizeTag(readString(extra, 'utmSource', 'utm_source')),
    medium: normalizeTag(readString(extra, 'utmMedium', 'utm_medium')),
    campaign: normalizeTag(readString(extra, 'utmCampaign', 'utm_campaign')),
    device: normalizeTag(readString(extra, 'device', 'dispositivo')),
    visitorHash: visitorId !== null ? pseudonymizer.hashVisitorId(visitorId) : null,
  };
}

export function mapOrder(
  order: UappiOrder,
  deps: MapOrderDeps,
): { order: MappedOrder; items: MappedOrderItem[] } {
  const emittedAt = parseUappiDate(order.dataEmissao);

  const mapped: MappedOrder = {
    numeroPedido: order.numeroPedido,
    idPedido: order.idPedido ?? order.numeroPedido,
    statusLabel: order.status.descricao,
    statusId: order.status.id,
    statusGroup: resolveStatusGroup(order.status.id, order.status.descricao, deps.statusOverrides),
    canal: order.canal ?? null,
    origem: order.origem ?? null,
    tipoVenda: order.tipoVenda ?? null,
    emittedAt,
    subtotalCents: toCents(order.valores.subtotal),
    freightCents: toCents(order.valores.frete),
    discountCents: toCents(order.valores.descontos),
    totalCents: toCents(order.valores.totalPedido),
    currency: order.moeda,
    paymentMethod: order.pagamento[0]?.descricao?.trim() || null,
    customer: mapCustomer(order, deps.pseudonymizer),
    attribution: mapAttribution(order, deps.pseudonymizer),
    rawPayload: redactRawPayload(order),
  };

  const items: MappedOrderItem[] = order.itens.map((item) => ({
    // SKU vazio quebraria o agrupamento de "produto mais vendido"; um marcador
    // explícito deixa o problema visível no relatório em vez de sumir.
    sku: item.sku?.trim() || SKU_PLACEHOLDER,
    productName: item.descricao.trim() || SKU_PLACEHOLDER,
    categoryName: item.categoria?.trim() || null,
    quantity: Math.trunc(item.quantidade),
    unitPriceCents: toCents(item.valorUnitario),
    totalPriceCents: toCents(item.valorTotal),
  }));

  return { order: mapped, items };
}

export { BUSINESS_TIME_ZONE };
