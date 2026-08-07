import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render.js';
import { RankingTable } from '../components/charts/RankingTable.js';
import type { RankingResult } from '../lib/api-client.js';

const result: RankingResult = {
  dimension: 'product', from: '2026-01-01', to: '2026-01-31',
  total: 50000, unit: 'currency',
  rows: [
    { key: 'CAM', label: 'Camiseta', value: 30000, unit: 'currency', extra: { quantity: 6, orders: 3 }, share: 0.6 },
    { key: 'TEN', label: 'Tênis', value: 20000, unit: 'currency', extra: { quantity: 1, orders: 1 }, share: 0.4 },
  ],
};

describe('RankingTable', () => {
  it('renders one row per entry with formatted values', () => {
    renderWithProviders(<RankingTable title="Produtos" result={result} />);
    expect(screen.getByRole('cell', { name: 'Camiseta' })).toBeInTheDocument();
    expect(screen.getByText(/300,00/)).toBeInTheDocument();
  });

  it('shows the share as a percentage', () => {
    renderWithProviders(<RankingTable title="Produtos" result={result} />);
    expect(screen.getByText('60,0%')).toBeInTheDocument();
  });

  it('numbers the positions so the ranking is explicit', () => {
    renderWithProviders(<RankingTable title="Produtos" result={result} />);
    expect(screen.getByRole('cell', { name: '1' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2' })).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    renderWithProviders(<RankingTable title="Produtos" result={undefined} isLoading />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows the error', () => {
    renderWithProviders(<RankingTable title="Produtos" result={undefined} error={new Error('sem dados')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('sem dados');
  });

  it('shows the empty state for a ranking with no rows', () => {
    renderWithProviders(<RankingTable title="Produtos" result={{ ...result, rows: [], total: 0 }} />);
    expect(screen.getByText('Sem dados no período selecionado')).toBeInTheDocument();
  });
});
