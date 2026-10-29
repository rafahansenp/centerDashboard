import { UappiOrderSchema, UappiOrderSummarySchema } from '../uappi/schemas.js';

const fullOrder = {
  idPedido: 9001,
  numeroPedido: 'PED-2026-0001',
  canal: 'site',
  origem: 'organico',
  tipoVenda: 'varejo',
  dataEmissao: '2026-07-15 14:30:00',
  moeda: 'BRL',
  status: { id: 3, descricao: 'Pagamento aprovado' },
  cliente: {
    idCliente: 555,
    email: 'ana@example.com',
    documento: '123.456.789-09',
    nomeRazao: 'Ana Silva',
  },
  valores: { subtotal: 200.0, frete: 20.5, descontos: 10.0, totalPedido: 210.5 },
  pagamento: [{ idPagamento: 1, descricao: 'Cartão de crédito', valor: 210.5 }],
  itens: [
    { sku: 'CAM-001', descricao: 'Camiseta Preta', categoria: 'Vestuário', quantidade: 2, valorUnitario: 80.0, valorTotal: 160.0 },
    { sku: 'MEI-002', descricao: 'Meia', quantidade: 1, valorUnitario: 40.0, valorTotal: 40.0 },
  ],
  informacoesAdicionais: { centerVisitorId: '1234567890.1699999999', utmCampaign: 'black-friday' },
};

describe('UappiOrderSchema', () => {
  it('parses a complete order', () => {
    const parsed = UappiOrderSchema.parse(fullOrder);
    expect(parsed.numeroPedido).toBe('PED-2026-0001');
    expect(parsed.itens).toHaveLength(2);
  });

  it('coerces a numeric order number to string', () => {
    expect(UappiOrderSchema.parse({ ...fullOrder, numeroPedido: 20260001 }).numeroPedido)
      .toBe('20260001');
  });

  it('accepts monetary values that arrive as strings', () => {
    const parsed = UappiOrderSchema.parse({
      ...fullOrder,
      valores: { subtotal: '200.00', frete: '20.50', descontos: '10.00', totalPedido: '210.50' },
    });
    expect(parsed.valores.totalPedido).toBe('210.50');
  });

  it('survives an order with no items', () => {
    expect(UappiOrderSchema.parse({ ...fullOrder, itens: [] }).itens).toEqual([]);
  });

  it('survives a missing itens key entirely', () => {
    const { itens: _omitted, ...withoutItems } = fullOrder;
    expect(UappiOrderSchema.parse(withoutItems).itens).toEqual([]);
  });

  it('survives a missing payment array', () => {
    const { pagamento: _omitted, ...withoutPayment } = fullOrder;
    expect(UappiOrderSchema.parse(withoutPayment).pagamento).toEqual([]);
  });

  it('survives an order with no customer document or email', () => {
    const parsed = UappiOrderSchema.parse({
      ...fullOrder, cliente: { idCliente: 555, nomeRazao: 'Consumidor' },
    });
    expect(parsed.cliente?.email).toBeUndefined();
  });

  it('keeps unknown fields instead of stripping them', () => {
    const parsed = UappiOrderSchema.parse({ ...fullOrder, campoNovoDaUappi: 'x' }) as Record<string, unknown>;
    expect(parsed.campoNovoDaUappi).toBe('x');
  });

  it('accepts a status given as a plain string', () => {
    const parsed = UappiOrderSchema.parse({ ...fullOrder, status: 'Pagamento aprovado' });
    expect(parsed.status.descricao).toBe('Pagamento aprovado');
    expect(parsed.status.id).toBe(0);
  });

  it('rejects an order with no numeroPedido — it is the natural key', () => {
    const { numeroPedido: _omitted, ...withoutKey } = fullOrder;
    expect(UappiOrderSchema.safeParse(withoutKey).success).toBe(false);
  });

  it('rejects an order with no dataEmissao — every metric buckets by it', () => {
    const { dataEmissao: _omitted, ...withoutDate } = fullOrder;
    expect(UappiOrderSchema.safeParse(withoutDate).success).toBe(false);
  });
});

describe('UappiOrderSummarySchema', () => {
  it('parses the minimal shape the list endpoint returns', () => {
    const parsed = UappiOrderSummarySchema.parse({
      numeroPedido: 'PED-1', dataEmissao: '2026-07-15 10:00:00',
    });
    expect(parsed.numeroPedido).toBe('PED-1');
  });

  it('rejects a summary without an order number', () => {
    expect(UappiOrderSummarySchema.safeParse({ dataEmissao: '2026-07-15' }).success).toBe(false);
  });
});
