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

/**
 * Nomes de chave (já normalizados: minúsculos, sem acento, sem separador)
 * que indicam dado pessoal. Igualdade EXATA contra este conjunto — não mais
 * correspondência por "contém" (achado da revisão final de verificação de
 * branch sobre o redator recursivo introduzido no commit 1245a8b).
 *
 * Por que a troca: correspondência por substring redigia de mais E de menos
 * ao mesmo tempo, confirmado rodando `mapOrder` de verdade.
 *  - De mais: o fragmento "nome" apagava `nomeProduto`, `nomeCategoria`,
 *    `nomeTransportadora`, `nomeFantasia`, `nomeStatus`; "endereco" apagava
 *    `enderecoLoja`. Nenhum desses é PII — são exatamente os dados de
 *    produto/categoria/transportadora/loja que `rawPayload` existe para
 *    preservar para reprocessamento offline. Uma loja cujo endpoint de
 *    detalhe de pedido nomeia os campos de produto `nomeProduto` (a Uappi
 *    varia o nome do campo por loja/endpoint — daí `CustomerSchema`/
 *    `UappiOrderSchema` serem `.passthrough()`) sincroniza e perde todo
 *    produto/categoria/transportadora do payload arquivado.
 *  - De menos: nenhum fragmento da lista antiga aparecia dentro de
 *    `whatsapp`, `contato`, `rg`, `inscricaoEstadual`, `dataNascimento`,
 *    `destinatario`, `titular`, `cartao`, `observacao`, `ip` — todos
 *    plausíveis num payload de e-commerce brasileiro, e todos escapavam
 *    intactos para o banco.
 *
 * Este conjunto é curado, não mecanicamente copiado de uma lista de
 * achados: lista o nome completo normalizado de cada campo (incluindo
 * variantes compostas óbvias, como `nomeRazao`/`enderecoEntrega`/
 * `telefoneCelular`), porque igualdade exata não "olha para dentro" de um
 * nome composto — só listar o fragmento base ("nome", "endereco",
 * "telefone") não bastaria para casar essas variantes reais.
 *
 * Duas decisões de zona cinzenta, tomadas deliberadamente:
 *  - `ip` e `observacao`/`observacoes` ENTRAM: um IP é dado pessoal sob a
 *    LGPD (identifica dispositivo/pessoa), e um campo de observação livre
 *    em payload de e-commerce brasileiro comumente carrega telefone/
 *    endereço anotado à mão por um atendente. Nenhum dos dois alimenta o
 *    reprocessamento dos campos MODELADOS (pedido, itens, dinheiro,
 *    status) — perder o valor bruto deles não quebra nada que
 *    `rawPayload` precise reconstruir.
 *  - `numero` FICA DE FORA, propositalmente: é ambíguo entre "número da
 *    casa" (dado pessoal, mas dentro de um objeto de endereço que já é
 *    redigido por inteiro via `endereco`/`enderecoEntrega`) e "número de
 *    pedido/item/rastreio" (dado operacional que o reprocessamento existe
 *    para ler). Redigir a chave nua `numero` arrisca reproduzir o Defeito 1
 *    (sobre-redação) num campo usado para agrupar/relatar. Prefere-se o
 *    risco remoto de um número de casa isolado sobreviver (sem nome/rua ao
 *    redor, já que o objeto-pai de endereço é redigido por inteiro) a
 *    apagar dado operacional do pedido.
 *
 * Tradeoff aceito conscientemente: igualdade exata não pega uma chave nova
 * de PII que a Uappi passe a mandar amanhã sob um nome fora deste conjunto
 * (ex.: `celularWhats`) — diferente do fragmento antigo, que ao menos pegava
 * variantes desconhecidas contendo uma raiz conhecida. Esse é o preço de
 * parar de apagar dado que não é PII. Quem fecha essa lacuna é a pendência
 * manual já registrada no ledger da feature ("validar contra um pedido REAL
 * da Uappi" — ver `progress.md`, decisão "PII no rawPayload: endurecer
 * agora"): é ela quem deve revelar nomes de campo reais ainda não cobertos
 * aqui, não uma tentativa de adivinhar todo nome futuro por substring.
 */
const PII_EXACT_KEYS = new Set<string>([
  // Identidade
  'nome', 'nomecompleto', 'nomecliente', 'nomerazao', 'razaosocial', 'nomerazaosocial',
  'nomedestinatario', 'destinatario', 'titular', 'nometitular', 'nomecontato', 'contato',

  // Documento
  'cpf', 'cnpj', 'documento', 'documentocliente', 'rg',
  'inscricaoestadual', 'datanascimento', 'nascimento',

  // Contato
  'email', 'emailcliente', 'emailsecundario', 'emailcontato',
  'telefone', 'telefonecelular', 'telefonecontato', 'celular', 'fone', 'fonecelular', 'whatsapp',

  // Endereço
  'endereco', 'enderecoentrega', 'enderecocliente', 'enderecofaturamento', 'enderecocobranca',
  'logradouro', 'complemento', 'bairro', 'cep',

  // Instrumento de pagamento
  'cartao', 'numerocartao', 'cartaocredito', 'dadoscartao', 'cvv', 'titularcartao',

  // Zona cinzenta resolvida a favor da redação (ver justificativa acima)
  'ip', 'observacao', 'observacoes',
]);

/** Minúsculo, sem acento, sem separador — casa `Nome`, `nome_razao`, `telefoneCelular`, `RAZAO-SOCIAL`… */
function normalizeKeyForPiiMatch(key: string): string {
  return key
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isPiiKey(key: string): boolean {
  return PII_EXACT_KEYS.has(normalizeKeyForPiiMatch(key));
}

/**
 * Percorre recursivamente objeto/array/primitivo e substitui por
 * `PII_REDACTED` o valor inteiro de qualquer chave cujo nome bata com
 * `isPiiKey`, em qualquer profundidade e sob qualquer chave-pai — é um
 * redator por nome de chave, não uma allowlist: tudo que não é PII
 * (itens, valores, status, pagamento, `idCliente`, `informacoesAdicionais`,
 * campos ainda desconhecidos de lojas futuras…) sobrevive intacto para
 * reprocessamento. Nunca muta a entrada: sempre devolve uma estrutura nova,
 * então quem já leu `order.cliente.email`/`documento` para gerar o hash
 * continua vendo os valores reais — a chamada a este redator só acontece
 * depois, sobre uma cópia.
 */
function redactPiiDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactPiiDeep(item));

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isPiiKey(key) ? PII_REDACTED : redactPiiDeep(nested);
    }
    return result;
  }

  return value;
}

/**
 * `rawPayload` guarda o pedido inteiro para reprocessamento offline. Devolve
 * uma cópia redigida recursivamente (ver `redactPiiDeep`) — não mais um
 * denylist de 3 campos fixos dentro de `cliente`.
 */
function redactRawPayload(order: UappiOrder): unknown {
  return redactPiiDeep(order);
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
