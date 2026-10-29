import { Pseudonymizer } from '@center/pii';
import { UappiOrderSchema } from '../uappi/schemas.js';
import { mapOrder, parseUappiDate } from '../uappi/mapper.js';

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
  cliente: { idCliente: 555, email: 'Ana@Example.com', documento: '123.456.789-09', nomeRazao: 'Ana Silva Souza' },
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

  it('redacts customer PII in rawPayload while preserving the rest for reprocessing', () => {
    const { order } = map();
    const serialized = JSON.stringify(order.rawPayload);

    // Nem e-mail, nem documento, nem razão social em claro.
    expect(serialized).not.toContain('Ana@Example.com');
    expect(serialized).not.toContain('ana@example.com');
    expect(serialized).not.toContain('123.456.789-09');
    expect(serialized).not.toContain('12345678909');
    expect(serialized).not.toContain('Ana Silva Souza');

    // O resto do payload sobrevive intacto — a redação não pode esvaziar tudo.
    expect(serialized).toContain('PED-2026-0001');
    expect(serialized).toContain('CAM-001');
    const payload = order.rawPayload as { cliente?: { idCliente?: unknown; email?: unknown } };
    expect(payload.cliente?.idCliente).toBe(555);
    expect(payload.cliente?.email).toBe('[REDACTED]');
  });

  // Achado B4 (revisão final de branch): o denylist de 3 campos fixos da T8
  // só cobria `cliente.email/documento/nomeRazao`. Payloads reais de
  // detalhe de pedido da Uappi trazem `entrega`/`enderecoEntrega` com nome,
  // telefone e endereço completos FORA de `cliente` inteiramente — o
  // redator agora anda a árvore inteira por nome de chave, não uma lista
  // fixa de posições.
  describe('redação recursiva de PII (B4)', () => {
    it('redacts PII nested outside cliente, at any depth (entrega.enderecoEntrega.telefone)', () => {
      const { order } = map({
        entrega: {
          transportadora: 'Correios',
          prazoDias: 5,
          enderecoEntrega: {
            nomeDestinatario: 'Carlos Souza',
            logradouro: 'Rua das Flores, 123',
            bairro: 'Centro',
            cep: '01310-100',
            telefone: '11988887777',
          },
        },
      });
      const serialized = JSON.stringify(order.rawPayload);

      expect(serialized).not.toContain('Carlos Souza');
      expect(serialized).not.toContain('Rua das Flores');
      expect(serialized).not.toContain('11988887777');
      expect(serialized).not.toContain('01310-100');

      const payload = order.rawPayload as {
        entrega?: { transportadora?: unknown; prazoDias?: unknown; enderecoEntrega?: unknown };
      };
      // A chave "enderecoEntrega" ela mesma bate com o fragmento "endereco" —
      // o valor inteiro (nome, logradouro, bairro, cep, telefone juntos, o
      // que por si só já identifica onde o cliente mora) é substituído,
      // não recursivamente vasculhado por campo.
      expect(payload.entrega?.enderecoEntrega).toBe('[REDACTED]');
      // Mas os irmãos de enderecoEntrega, que não são PII, sobrevivem —
      // é um redator por nome de chave, não uma allowlist do objeto inteiro.
      expect(payload.entrega?.transportadora).toBe('Correios');
      expect(payload.entrega?.prazoDias).toBe(5);
    });

    it('preserves a genuinely non-PII field at any nesting depth', () => {
      const { order } = map({
        entrega: {
          transportadora: 'Correios',
          prazoDias: 5,
          rastreamento: { codigoRastreio: 'BR123456789', status: 'em trânsito' },
        },
      });
      const payload = order.rawPayload as {
        entrega?: { transportadora?: unknown; prazoDias?: unknown; rastreamento?: { codigoRastreio?: unknown; status?: unknown } };
      };
      // Nada aqui bate com um fragmento de nome de chave PII, em nenhuma
      // profundidade — tudo sobrevive intacto para reprocessamento.
      expect(payload.entrega?.transportadora).toBe('Correios');
      expect(payload.entrega?.prazoDias).toBe(5);
      expect(payload.entrega?.rastreamento?.codigoRastreio).toBe('BR123456789');
      expect(payload.entrega?.rastreamento?.status).toBe('em trânsito');
    });

    it('matches PII key names regardless of casing, accents and separators', () => {
      const { order } = map({
        informacoesAdicionais: {
          centerVisitorId: '1234567890.1699999999',
          utmCampaign: 'black-friday',
          TELEFONE_CELULAR: '11977776666',
          'E-Mail-Secundário': 'outro@example.com',
        },
      });
      const serialized = JSON.stringify(order.rawPayload);
      expect(serialized).not.toContain('11977776666');
      expect(serialized).not.toContain('outro@example.com');
    });

    // Revisão final de branch, achado sobre B4: correspondência por
    // "contém" redige demais. `nome` como fragmento apaga qualquer chave que
    // contenha a substring, mesmo quando ela não é PII nenhuma —
    // `nomeProduto`, `nomeCategoria`, `nomeFantasia` etc. são dados de
    // produto/loja que o rawPayload existe para preservar.
    it('does NOT redact non-personal keys that merely contain a PII fragment as a substring (defeito de sobre-redação)', () => {
      const { order } = map({
        itens: [
          {
            sku: 'CAM-001',
            descricao: 'Camiseta Preta',
            categoria: 'Vestuário',
            quantidade: 1,
            valorUnitario: 10,
            valorTotal: 10,
            nomeProduto: 'Camiseta Preta Premium',
            nomeCategoria: 'Vestuário Masculino',
            nomeTransportadora: 'Correios',
          },
        ],
        nomeFantasia: 'Loja da Ana Ltda',
        nomeStatus: 'Pagamento aprovado',
        enderecoLoja: 'Av. Paulista, 1000',
      });
      const payload = order.rawPayload as Record<string, unknown> & {
        itens?: Array<Record<string, unknown>>;
      };

      expect(payload.nomeFantasia).toBe('Loja da Ana Ltda');
      expect(payload.nomeStatus).toBe('Pagamento aprovado');
      expect(payload.enderecoLoja).toBe('Av. Paulista, 1000');
      expect(payload.itens?.[0]?.nomeProduto).toBe('Camiseta Preta Premium');
      expect(payload.itens?.[0]?.nomeCategoria).toBe('Vestuário Masculino');
      expect(payload.itens?.[0]?.nomeTransportadora).toBe('Correios');
    });

    // Achado sobre B4: correspondência por "contém" também redige de menos —
    // chaves plausíveis de PII num payload brasileiro que não contêm
    // nenhum dos fragmentos originais (`email`, `documento`, `cpf`, `cnpj`,
    // `nome`, `razaosocial`, `telefone`, `celular`, `fone`, `endereco`,
    // `logradouro`, `complemento`, `bairro`, `cep`) escapavam intactas.
    it('DOES redact plausible Brazilian PII keys the old fragment list missed, including nested and mis-cased (defeito de sub-redação)', () => {
      const { order } = map({
        whatsapp: '11988887777',
        rg: '12.345.678-9',
        cliente: {
          idCliente: 555,
          email: 'ana@example.com',
          documento: '123.456.789-09',
          contato: 'Ana Silva',
          titular: 'Ana Silva Souza',
          inscricaoEstadual: '123.456.789.110',
          dataNascimento: '1990-05-20',
        },
        entrega: {
          DESTINATARIO: 'Carlos Souza',
          Cartao: '4111 1111 1111 1111',
          Observacao: 'Deixar com o porteiro, tel 11988887777',
        },
      });
      const serialized = JSON.stringify(order.rawPayload);

      expect(serialized).not.toContain('11988887777');
      expect(serialized).not.toContain('12.345.678-9');
      expect(serialized).not.toContain('Ana Silva');
      expect(serialized).not.toContain('Ana Silva Souza');
      expect(serialized).not.toContain('123.456.789.110');
      expect(serialized).not.toContain('1990-05-20');
      expect(serialized).not.toContain('Carlos Souza');
      expect(serialized).not.toContain('4111 1111 1111 1111');
      expect(serialized).not.toContain('Deixar com o porteiro');

      const payload = order.rawPayload as {
        whatsapp?: unknown;
        rg?: unknown;
        entrega?: Record<string, unknown>;
      };
      expect(payload.whatsapp).toBe('[REDACTED]');
      expect(payload.rg).toBe('[REDACTED]');
      expect(payload.entrega?.DESTINATARIO).toBe('[REDACTED]');
      expect(payload.entrega?.Cartao).toBe('[REDACTED]');
      expect(payload.entrega?.Observacao).toBe('[REDACTED]');
    });

    it('still hashes the real (pre-redaction) cliente values, not the redacted placeholder', () => {
      // A ordem importa: o redator roda sobre uma CÓPIA, depois que o hashing
      // já leu os valores reais — nunca o inverso, senão emailHash/
      // documentHash virariam hash de "[REDACTED]" em vez do dado real.
      const pseudonymizer2 = new Pseudonymizer('p'.repeat(32));
      const expectedEmailHash = pseudonymizer2.hashEmail('ana@example.com');
      const expectedDocumentHash = pseudonymizer2.hashDocument('12345678909');

      const { order } = map();
      expect(order.customer?.emailHash).toBe(expectedEmailHash);
      expect(order.customer?.documentHash).toBe(expectedDocumentHash);
      // E, por garantia, os hashes não podem ser derivados do placeholder.
      expect(order.customer?.emailHash).not.toBe(pseudonymizer2.hashEmail('[REDACTED]'));
    });
  });
});
