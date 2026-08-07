import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render.js';
import { ChartFrame } from '../components/charts/ChartFrame.js';

const tableColumns = ['Data', 'Faturamento'];
const tableRows = [['01/01', 'R$ 550,00'], ['02/01', 'R$ 610,00']];

describe('ChartFrame', () => {
  it('renders the chart by default and hides the table', () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={tableRows}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('swaps to the accessible table view on toggle', async () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={tableRows}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Faturamento' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'R$ 550,00' })).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('goes back to the chart on a second toggle', async () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={tableRows}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ver como gráfico' }));
    expect(screen.getByTestId('chart')).toBeInTheDocument();
  });

  it('shows a loading state instead of the chart', () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={[]} isLoading>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('shows the error and hides the table toggle', () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={[]} error={new Error('Uappi fora do ar')}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Uappi fora do ar');
    expect(screen.queryByRole('button', { name: 'Ver como tabela' })).not.toBeInTheDocument();
  });

  it('shows an empty state when there is no data', () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={[]}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByText('Sem dados no período selecionado')).toBeInTheDocument();
  });
});
