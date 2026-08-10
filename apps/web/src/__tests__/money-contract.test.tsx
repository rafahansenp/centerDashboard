import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render.js';
import { formatMetricValue } from '../lib/format.js';
import { KpiCard } from '../components/charts/KpiCard.js';
import { RankingTable } from '../components/charts/RankingTable.js';
import type { RankingResult } from '../lib/api-client.js';

const CENTS = 480000;

/** Sem quebra fina — `Intl` usa U+00A0 entre "R$" e o número. */
function normalize(text: string): string {
  return text.replace(/ /g, ' ');
}

describe('contrato de centavos — formatação', () => {
  it('renders the canonical value as R$ 4.800,00, never R$ 480.000,00', () => {
    expect(normalize(formatMetricValue(CENTS, 'currency'))).toBe('R$ 4.800,00');
  });

  it('does not divide count metrics by 100', () => {
    expect(formatMetricValue(CENTS, 'count')).toBe('480.000');
  });

  it('renders one cent as R$ 0,01', () => {
    expect(normalize(formatMetricValue(1, 'currency'))).toBe('R$ 0,01');
  });
});

describe('contrato de centavos — componentes', () => {
  it('KpiCard divides by 100 exactly once', () => {
    renderWithProviders(<KpiCard label="Faturamento" value={CENTS} unit="currency" />);
    expect(screen.getByText(/4\.800,00/)).toBeInTheDocument();
    expect(screen.queryByText(/480\.000,00/)).not.toBeInTheDocument();
  });

  it('RankingTable divides by 100 exactly once', () => {
    const result: RankingResult = {
      dimension: 'product', from: '2026-01-01', to: '2026-01-31',
      total: CENTS, unit: 'currency',
      rows: [{ key: 'CAM', label: 'Camiseta', value: CENTS, unit: 'currency', extra: {}, share: 1 }],
    };
    renderWithProviders(<RankingTable title="Produtos" result={result} />);
    expect(screen.getByText(/4\.800,00/)).toBeInTheDocument();
    expect(screen.queryByText(/480\.000,00/)).not.toBeInTheDocument();
  });

  it('KpiCard computes the delta on cents, so the percentage is unaffected by the unit', () => {
    // 480000 → 600000 é +25%, exatamente como 4800 → 6000 seria.
    renderWithProviders(
      <KpiCard label="Faturamento" value={600000} previousValue={CENTS} unit="currency" />,
    );
    expect(screen.getByText('+25,0%')).toBeInTheDocument();
  });
});
