/**
 * Dinheiro circula como inteiro de centavos. Ponto flutuante acumula erro e um
 * relatório de faturamento errado por centavos é indefensável.
 */
export function toCents(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`valor monetário inválido: ${value}`);
    return Math.sign(value) * Math.round(Math.abs(value) * 100);
  }

  const normalized = value.trim().includes(',')
    // "1.234,56" (pt-BR) → "1234.56"
    ? value.trim().replace(/\./g, '').replace(',', '.')
    : value.trim();

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`valor monetário inválido: "${value}"`);
  }

  const parsed = Number(normalized);
  return Math.sign(parsed) * Math.round(Math.abs(parsed) * 100);
}

export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}
