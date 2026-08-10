import { fromCents, sumCents, toCents } from '../money.js';
import { MetricSeriesSchema } from '../metrics.js';

/** O valor canônico de toda esta suíte: R$ 4.800,00. */
const REAIS = '4800.00';
const CENTS = 480000;

describe('contrato de centavos — conversão', () => {
  it('converts the canonical value in both directions', () => {
    expect(toCents(REAIS)).toBe(CENTS);
    expect(fromCents(CENTS)).toBe(REAIS);
  });

  it('round-trips without drift across 1000 sequential values', () => {
    // Um erro de arredondamento de 1 centavo por pedido vira R$ 10,00 a cada
    // mil pedidos — invisível numa amostra, indefensável num fechamento.
    for (let cents = 0; cents < 1000; cents += 1) {
      expect(toCents(fromCents(cents))).toBe(cents);
    }
  });

  it('sums a thousand values of R$ 0,01 to exactly R$ 10,00', () => {
    const values = Array.from({ length: 1000 }, () => toCents('0.01'));
    expect(sumCents(values)).toBe(1000);
    expect(fromCents(sumCents(values))).toBe('10.00');
  });

  it('never produces a fractional cent from any input shape', () => {
    for (const input of [REAIS, '4.800,00', 4800, '0.005', '0.004', '-15.50']) {
      expect(Number.isInteger(toCents(input))).toBe(true);
    }
  });
});

describe('contrato de centavos — série de métrica', () => {
  it('carries currency values as integers, never as decimals', () => {
    const series = MetricSeriesSchema.parse({
      metricId: 'commerce.revenue', source: 'commerce', unit: 'currency',
      granularity: 'day', total: CENTS,
      points: [{ date: '2026-01-01', value: CENTS }],
    });
    expect(Number.isInteger(series.total)).toBe(true);
    expect(Number.isInteger(series.points[0]!.value)).toBe(true);
    // Se alguém "corrigir" a série para reais, este número deixa de ser inteiro.
    expect(series.total).toBe(CENTS);
  });
});
