import { z } from 'zod';

/** Aceita número ou string: a Uappi varia o tipo entre lojas e endpoints. */
const MoneySchema = z.union([z.number(), z.string()]);

/** Alguns campos numéricos chegam como string; coerção evita quebrar o sync. */
const NumericSchema = z.coerce.number();

/**
 * Status às vezes vem como objeto `{ id, descricao }`, às vezes como string
 * simples. Normalizamos para objeto — `id: 0` sinaliza "veio sem id".
 */
const StatusSchema = z.union([
  z.object({
    id: NumericSchema.default(0),
    descricao: z.string().default(''),
  }).passthrough(),
  z.string().transform((descricao) => ({ id: 0, descricao })),
]);

const CustomerSchema = z.object({
  idCliente: z.union([z.number(), z.string()]).optional(),
  email: z.string().optional(),
  documento: z.string().optional(),
  nomeRazao: z.string().optional(),
}).passthrough();

const ItemSchema = z.object({
  sku: z.union([z.string(), z.number()]).transform(String).optional(),
  descricao: z.string().default(''),
  categoria: z.string().optional(),
  quantidade: NumericSchema.default(1),
  valorUnitario: MoneySchema.default(0),
  valorTotal: MoneySchema.default(0),
}).passthrough();

const PaymentSchema = z.object({
  idPagamento: z.union([z.number(), z.string()]).optional(),
  descricao: z.string().default(''),
  valor: MoneySchema.default(0),
}).passthrough();

const ValuesSchema = z.object({
  subtotal: MoneySchema.default(0),
  frete: MoneySchema.default(0),
  descontos: MoneySchema.default(0),
  totalPedido: MoneySchema.default(0),
}).passthrough();

/**
 * Schema deliberadamente tolerante. A Uappi é multi-loja: campos opcionais
 * variam por configuração, e um schema estrito derrubaria o sync inteiro por
 * causa de um pedido atípico. Só `numeroPedido` e `dataEmissao` são obrigatórios
 * — sem eles não há chave natural nem bucket temporal, e o registro é inútil.
 * O payload completo é preservado em `rawPayload`, então nada se perde.
 */
export const UappiOrderSchema = z.object({
  idPedido: z.union([z.number(), z.string()]).transform(String).optional(),
  numeroPedido: z.union([z.string(), z.number()]).transform(String),
  canal: z.string().optional(),
  origem: z.string().optional(),
  tipoVenda: z.string().optional(),
  dataEmissao: z.string().min(1),
  moeda: z.string().default('BRL'),
  status: StatusSchema.default({ id: 0, descricao: '' }),
  cliente: CustomerSchema.optional(),
  valores: ValuesSchema.default({}),
  pagamento: z.array(PaymentSchema).default([]),
  itens: z.array(ItemSchema).default([]),
  informacoesAdicionais: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export type UappiOrder = z.infer<typeof UappiOrderSchema>;

/** O que a listagem devolve — usada só para descobrir quais detalhes buscar. */
export const UappiOrderSummarySchema = z.object({
  numeroPedido: z.union([z.string(), z.number()]).transform(String),
  dataEmissao: z.string().optional(),
}).passthrough();

export type UappiOrderSummary = z.infer<typeof UappiOrderSummarySchema>;
