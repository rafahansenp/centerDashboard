import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render.js';
import { KpiCard } from '../components/charts/KpiCard.js';

describe('KpiCard', () => {
  it('formats currency from cents', () => {
    renderWithProviders(<KpiCard label="Faturamento" value={1234560} unit="currency" />);
    expect(screen.getByText(/12\.345,60/)).toBeInTheDocument();
  });

  it('shows a positive delta with a direction word, not only a colour', () => {
    renderWithProviders(<KpiCard label="Pedidos" value={120} previousValue={100} unit="count" />);
    expect(screen.getByText('+20,0%')).toBeInTheDocument();
    expect(screen.getByText(/aumento/i)).toBeInTheDocument();
  });

  it('shows a negative delta', () => {
    renderWithProviders(<KpiCard label="Pedidos" value={80} previousValue={100} unit="count" />);
    expect(screen.getByText('-20,0%')).toBeInTheDocument();
    expect(screen.getByText(/queda/i)).toBeInTheDocument();
  });

  it('omits the delta when there is no previous value', () => {
    renderWithProviders(<KpiCard label="Pedidos" value={120} unit="count" />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('omits the delta when the previous value is zero', () => {
    renderWithProviders(<KpiCard label="Pedidos" value={120} previousValue={0} unit="count" />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('shows the error instead of a stale value', () => {
    renderWithProviders(<KpiCard label="Pedidos" value={0} unit="count" error={new Error('fonte fora do ar')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('fonte fora do ar');
  });
});
