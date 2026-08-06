import { Pseudonymizer } from '@center/pii';
import { UappiOrderSchema } from '../schemas.js';
import { mapOrder, parseUappiDate } from '../mapper.js';

const pseudonymizer = new Pseudonymizer('p'.repeat(32));

const rawOrder = {
  idPedido: 9001,
  numeroPedido: 'PED-2026-0001',
  canal: 'site',
  origem: 'organico',
  tipoVenda: 'varejo',
  dataEmissao: '2026-07-15 14:30:00',
  moeda: 'BRL',
  status: { id: 3, descricao: 'Pagamento aprovado' },
  cliente: { idCliente: 555, email: 'Ana@Example.com', documento: '123.456.789-09' },
  valores: { subtotal: 200.0, frete: 20.5, descontos: 10.0, totalPedido: 210.5 },
  pagamento: [{ idPagamento: 1, descricao: 'Cartão de crédito', valor: 210.5 }],
  itens: [
    { sku: 'CAM-001', descricao: 'Camiseta Preta', categoria: 'Vestuário', quantidade: 2, valorUnitario: 80.0, valorTotal: 160.0 },
    { sku: 'MEI-002', descricao: 'Meia', quantidade: 1, valorUnitario: 40.0, valorTotal: 40.0 },
  ],
  informacoesAdicionais: {
    centerVisitorId: '1234567890.1699999999',
    utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'black-friday', device: 'mobile',
  },
};

function map(overrides: Record<string, unknown> = {}, statusOverrides?: Record<string, string>) {
  const parsed = UappiOrderSchema.parse({ ...rawOrder, ...overrides });
  return mapOrder(parsed, {
    pseudonymizer,
    ...(statusOverrides ? { statusOverrides } : {}),
  });
}

describe('parseUappiDate', () => {
  it('parses "YYYY-MM-DD HH:mm:ss" as São Paulo local time', () => {
    // 14:30 em São Paulo (UTC-3) = 17:30 UTC.
    expect(parseUappiDate('2026-07-15 14:30:00').toISOString()).toBe('2026-07-15T17:30:00.000Z');
  });

  it('parses a date without a time as midnight São Paulo', () => {
    expect(parseUappiDate('2026-07-15').toISOString()).toBe('2026-07-15T03:00:00.000Z');
  });

  it('respects an ISO string that already carries an offset', () => {
    expect(parseUappiDate('2026-07-15T14:30:00Z').toISOString()).toBe('2026-07-15T14:30:00.000Z');
  });

  it('throws on an unparseable value rather than producing Invalid Date', () => {
    expect(() => parseUappiDate('15/07/2026')).toThrow('dataEmissao inválida');
  });
});

describe('mapOrder — identificação e status', () => {
  it('keeps the natural key and ids as strings', () => {
    const { order } = map();
    expect(order.numeroPedido).toBe('PED-2026-0001');
    expect(order.idPedido).toBe('9001');
  });

  it('resolves the status group from the label', () => {
    const { order } = map();
    expect(order.statusGroup).toBe('PAID');
    expect(order.statusLabel).toBe('Pagamento aprovado');
    expect(order.statusId).toBe(3);
  });

  it('honours a per-store status override', () => {
    expect(map({}, { '3': 'PROCESSING' }).order.statusGroup).toBe('PROCESSING');
  });
});

describe('mapOrder — dinheiro', () => {
  it('converts every monetary field to integer cents', () => {
    const { order } = map();
    expect(order.subtotalCents).toBe(20000);
    expect(order.freightCents).toBe(2050);
    expect(order.discountCents).toBe(1000);
    expect(order.totalCents).toBe(21050);
  });

  it('handles values that arrive as decimal strings', () => {
    const { order } = map({
      valores: { subtotal: '200.00', frete: '20.50', descontos: '10.00', totalPedido: '210.50' },
    });
    expect(order.totalCents).toBe(21050);
  });

  it('handles values in Brazilian format with comma decimals', () => {
    const { order } = map({
      valores: { subtotal: '1.200,00', frete: '0,00', descontos: '0,00', totalPedido: '1.200,00' },
    });
    expect(order.totalCents).toBe(120000);
  });

  it('never produces a floating point cent', () => {
    const { order } = map({
      valores: { subtotal: 0.1, frete: 0.2, descontos: 0, totalPedido: 0.3 },
    });
    expect(Number.isInteger(order.totalCents)).toBe(true);
    expect(order.subtotalCents + order.freightCents).toBe(30);
  });
});

describe('mapOrder — dados pessoais', () => {
  it('stores only hashes, never the email or document', () => {
    const { order } = map();
    const serialized = JSON.stringify(order.customer);
    expect(serialized).not.toContain('Ana@Example.com');
    expect(serialized).not.toContain('ana@example.com');
    expect(serialized).not.toContain('12345678909');
    expect(serialized).not.toContain('123.456.789-09');
  });

  it('produces the same email hash regardless of casing and spacing', () => {
    const a = map().order.customer?.emailHash;
    const b = map({ cliente: { idCliente: 555, email: '  ana@example.com  ' } }).order.customer?.emailHash;
    expect(a).toBe(b);
  });

  it('produces the same document hash regardless of punctuation', () => {
    const a = map().order.customer?.documentHash;
    const b = map({ cliente: { idCliente: 555, documento: '12345678909' } }).order.customer?.documentHash;
    expect(a).toBe(b);
  });

  it('leaves the hashes null when the fields are absent', () => {
    const { order } = map({ cliente: { idCliente: 555 } });
    expect(order.customer).toEqual({ externalId: '555', emailHash: null, documentHash: null });
  });

  it('returns a null customer when the order has none', () => {
    expect(map({ cliente: undefined }).order.customer).toBeNull();
  });
});

describe('mapOrder — atribuição', () => {
  it('extracts UTM data and hashes the visitor id', () => {
    const { order } = map();
    expect(order.attribution.source).toBe('google');
    expect(order.attribution.medium).toBe('cpc');
    expect(order.attribution.campaign).toBe('black-friday');
    expect(order.attribution.device).toBe('mobile');
    expect(order.attribution.visitorHash).toBe(
      pseudonymizer.hashVisitorId('1234567890.1699999999'),
    );
  });

  it('never keeps the raw client id in the attribution', () => {
    const { order } = map();
    expect(JSON.stringify(order.attribution)).not.toContain('1234567890.1699999999');
  });

  it('returns nulls when informacoesAdicionais is absent', () => {
    const { order } = map({ informacoesAdicionais: undefined });
    expect(order.attribution).toEqual({
      source: null, medium: null, campaign: null, device: null, visitorHash: null,
    });
  });

  it('accepts snake_case utm keys as well', () => {
    const { order } = map({
      informacoesAdicionais: { utm_source: 'facebook', utm_campaign: 'natal' },
    });
    expect(order.attribution.source).toBe('facebook');
    expect(order.attribution.campaign).toBe('natal');
  });

  it('lowercases campaign and source so grouping does not split', () => {
    const { order } = map({
      informacoesAdicionais: { utmSource: 'Google', utmCampaign: 'Black-Friday' },
    });
    expect(order.attribution.source).toBe('google');
    expect(order.attribution.campaign).toBe('black-friday');
  });
});

describe('mapOrder — pagamento e itens', () => {
  it('takes the first payment method as the order method', () => {
    expect(map().order.paymentMethod).toBe('Cartão de crédito');
  });

  it('leaves the payment method null when there is none', () => {
    expect(map({ pagamento: [] }).order.paymentMethod).toBeNull();
  });

  it('maps every item with cents and a denormalised emission date', () => {
    const { items } = map();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      sku: 'CAM-001', productName: 'Camiseta Preta', categoryName: 'Vestuário',
      quantity: 2, unitPriceCents: 8000, totalPriceCents: 16000,
    });
    expect(items[1]?.categoryName).toBeNull();
  });

  it('substitutes a placeholder sku when the item has none', () => {
    const { items } = map({
      itens: [{ descricao: 'Item sem SKU', quantidade: 1, valorUnitario: 10, valorTotal: 10 }],
    });
    expect(items[0]?.sku).toBe('SEM-SKU');
  });

  it('rounds a fractional quantity up to a whole unit', () => {
    const { items } = map({
      itens: [{ sku: 'A', descricao: 'X', quantidade: 1.4, valorUnitario: 10, valorTotal: 14 }],
    });
    expect(items[0]?.quantity).toBe(1);
  });

  it('preserves a zero quantity instead of clamping it to 1', () => {
    const { items } = map({
      itens: [{ sku: 'A', descricao: 'X', quantidade: 0, valorUnitario: 10, valorTotal: 0 }],
    });
    expect(items[0]?.quantity).toBe(0);
  });

  it('preserves a negative quantity instead of clamping it to 1', () => {
    const { items } = map({
      itens: [{ sku: 'A', descricao: 'X', quantidade: -2, valorUnitario: 10, valorTotal: -20 }],
    });
    expect(items[0]?.quantity).toBe(-2);
  });

  it('produces no items when the order has none', () => {
    expect(map({ itens: [] }).items).toEqual([]);
  });
});

describe('mapOrder — preservação do payload', () => {
  it('keeps the whole raw order so it can be reprocessed offline', () => {
    const { order } = map();
    expect((order.rawPayload as Record<string, unknown>).numeroPedido).toBe('PED-2026-0001');
  });
});
