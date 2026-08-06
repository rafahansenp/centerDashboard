import { resolveStatusGroup } from '../status-map.js';

describe('resolveStatusGroup — padrões por texto', () => {
  it.each([
    ['Pago', 'PAID'],
    ['Pagamento aprovado', 'PAID'],
    ['Pagamento confirmado', 'PAID'],
    ['Aguardando pagamento', 'PENDING_PAYMENT'],
    ['Aguardando Pgto', 'PENDING_PAYMENT'],
    ['Pendente de pagamento', 'PENDING_PAYMENT'],
    ['Em separação', 'PROCESSING'],
    ['Em processamento', 'PROCESSING'],
    ['Enviado', 'SHIPPED'],
    ['Em transporte', 'SHIPPED'],
    ['Entregue', 'DELIVERED'],
    ['Cancelado', 'CANCELLED'],
    ['Cancelado pelo cliente', 'CANCELLED'],
    ['Pagamento recusado', 'FAILED'],
    ['Pagamento não autorizado', 'FAILED'],
    ['Estornado', 'FAILED'],
  ])('maps "%s" to %s', (label, expected) => {
    expect(resolveStatusGroup(1, label)).toBe(expected);
  });

  it('is accent and case insensitive', () => {
    expect(resolveStatusGroup(1, 'EM SEPARACAO')).toBe('PROCESSING');
    expect(resolveStatusGroup(1, 'aguardando pagamento')).toBe('PENDING_PAYMENT');
  });

  it('falls back to OTHER for an unrecognised label', () => {
    expect(resolveStatusGroup(1, 'Aguardando retirada na loja física')).toBe('OTHER');
  });

  it('prefers CANCELLED over PAID when both words appear', () => {
    // "Cancelado após pagamento" é um cancelamento, não uma venda.
    expect(resolveStatusGroup(1, 'Cancelado após pagamento aprovado')).toBe('CANCELLED');
  });

  it('prefers FAILED over PENDING when the payment was refused', () => {
    expect(resolveStatusGroup(1, 'Pagamento recusado, aguardando nova tentativa')).toBe('FAILED');
  });
});

describe('resolveStatusGroup — override por loja', () => {
  it('lets an override win over the text pattern', () => {
    expect(resolveStatusGroup(42, 'Pago', { '42': 'CANCELLED' })).toBe('CANCELLED');
  });

  it('ignores an override pointing to an unknown group', () => {
    expect(resolveStatusGroup(42, 'Pago', { '42': 'INVENTADO' })).toBe('PAID');
  });

  it('ignores an override for a different status id', () => {
    expect(resolveStatusGroup(7, 'Pago', { '42': 'CANCELLED' })).toBe('PAID');
  });
});
