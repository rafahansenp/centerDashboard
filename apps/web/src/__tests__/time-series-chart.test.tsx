import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render.js';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart.js';
import type { MetricSeries } from '../lib/api-client.js';

const commerce: MetricSeries = {
  metricId: 'commerce.orders', source: 'commerce', unit: 'count', granularity: 'day', total: 12,
  points: [{ date: '2026-01-01', value: 5 }, { date: '2026-01-02', value: 7 }],
};

const ga4: MetricSeries = {
  metricId: 'ga4.sessions', source: 'ga4', unit: 'count', granularity: 'day', total: 116,
  points: [{ date: '2026-01-01', value: 55 }, { date: '2026-01-02', value: 61 }],
};

describe('TimeSeriesChart', () => {
  it('renders inside a frame labelled with the title', () => {
    renderWithProviders(<TimeSeriesChart title="Pedidos" seriesList={[commerce]} granularity="day" unit="count" />);
    expect(screen.getByRole('region', { name: 'Pedidos' })).toBeInTheDocument();
  });

  it('builds a table row per bucket with a column per series', async () => {
    renderWithProviders(<TimeSeriesChart title="Volume" seriesList={[commerce, ga4]} granularity="day" unit="count" />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    expect(screen.getByRole('columnheader', { name: 'Loja (Uappi)' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '01/01' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '55' })).toBeInTheDocument();
  });

  it('aligns buckets across series that do not share every date', async () => {
    const sparse: MetricSeries = { ...ga4, points: [{ date: '2026-01-02', value: 61 }] };
    renderWithProviders(<TimeSeriesChart title="Volume" seriesList={[commerce, sparse]} granularity="day" unit="count" />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    // 01/01 só existe no commerce — a coluna do GA4 mostra zero, não some.
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('propagates the error to the frame', () => {
    renderWithProviders(
      <TimeSeriesChart title="Pedidos" seriesList={[]} granularity="day" unit="count" error={new Error('fora do ar')} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('fora do ar');
  });

  it('shows the empty state when every series is empty', () => {
    renderWithProviders(
      <TimeSeriesChart title="Pedidos" seriesList={[{ ...commerce, points: [] }]} granularity="day" unit="count" />,
    );
    expect(screen.getByText('Sem dados no período selecionado')).toBeInTheDocument();
  });

  it('formats currency in the table view from cents to reais', async () => {
    const revenue: MetricSeries = {
      metricId: 'commerce.revenue', source: 'commerce', unit: 'currency',
      granularity: 'day', total: 480000,
      points: [{ date: '2026-01-01', value: 480000 }],
    };
    renderWithProviders(
      <TimeSeriesChart title="Faturamento" seriesList={[revenue]} granularity="day" unit="currency" />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    // 480000 centavos são R$ 4.800,00 — nunca R$ 480.000,00.
    expect(screen.getByRole('cell', { name: /4\.800,00/ })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: /480\.000,00/ })).not.toBeInTheDocument();
  });
});
