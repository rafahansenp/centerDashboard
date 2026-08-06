import { fromCents, sumCents, toCents } from '../money.js';

describe('toCents', () => {
  it('converts a decimal string', () => {
    expect(toCents('1234.56')).toBe(123456);
  });

  it('converts a Brazilian formatted string', () => {
    expect(toCents('1.234,56')).toBe(123456);
  });

  it('converts a number', () => {
    expect(toCents(1234.56)).toBe(123456);
  });

  it('rounds half away from zero at the cent', () => {
    expect(toCents('0.005')).toBe(1);
    expect(toCents('0.004')).toBe(0);
  });

  it('handles zero and negative values', () => {
    expect(toCents('0')).toBe(0);
    expect(toCents('-15.50')).toBe(-1550);
  });

  it('throws on a non numeric string', () => {
    expect(() => toCents('abc')).toThrow('valor monetário inválido');
  });
});

describe('fromCents', () => {
  it('formats cents back to a decimal string', () => {
    expect(fromCents(123456)).toBe('1234.56');
  });

  it('pads the cents', () => {
    expect(fromCents(5)).toBe('0.05');
    expect(fromCents(50)).toBe('0.50');
  });

  it('formats zero and negatives', () => {
    expect(fromCents(0)).toBe('0.00');
    expect(fromCents(-1550)).toBe('-15.50');
  });
});

describe('sumCents', () => {
  it('sums without floating point drift', () => {
    // 0.1 + 0.2 em float dá 0.30000000000000004; em centavos dá 30.
    expect(sumCents([toCents('0.10'), toCents('0.20')])).toBe(30);
  });

  it('returns zero for an empty list', () => {
    expect(sumCents([])).toBe(0);
  });
});
