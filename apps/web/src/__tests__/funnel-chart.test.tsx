import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '../test/render.js';
import { FunnelChart } from '../components/charts/FunnelChart.js';
import type { FunnelResult } from '../lib/api-client.js';

/**
 * Funil de e-commerce padrão (5 etapas), no formato produzido pela tool
 * `checkout_funnel` do mcp-ga4 (Task 19 / Task 20). O maior abandono ocorre
 * entre "Visualizou produto" e "Adicionou ao carrinho".
 */
const result: FunnelResult = {
  from: '2026-01-01', to: '2026-01-31',
  steps: [
    { key: 'view_item', label: 'Visualizou produto', users: 10000, stepConversion: null, dropOff: 0 },
    { key: 'add_to_cart', label: 'Adicionou ao carrinho', users: 4000, stepConversion: 0.4, dropOff: 0.6 },
    { key: 'begin_checkout', label: 'Iniciou checkout', users: 2400, stepConversion: 0.6, dropOff: 0.4 },
    { key: 'add_payment_info', label: 'Informou pagamento', users: 2000, stepConversion: 0.8333333333333334, dropOff: 0.16666666666666666 },
    { key: 'purchase', label: 'Comprou', users: 1200, stepConversion: 0.6, dropOff: 0.4 },
  ],
  worstStepKey: 'add_to_cart',
  overallConversion: 0.12,
  identifiesUsers: true,
  note: 'Dados agregados por sessão via GA4; não implica causalidade entre as etapas.',
};

describe('FunnelChart', () => {
  it('renders one row per funnel step with label and user count', () => {
    renderWithProviders(<FunnelChart title="Funil de compra" result={result} />);
    expect(screen.getByText('Visualizou produto')).toBeInTheDocument();
    expect(screen.getByText('Comprou')).toBeInTheDocument();
    expect(screen.getByText(/10\.000/)).toBeInTheDocument();
    expect(screen.getByText(/1\.200/)).toBeInTheDocument();
  });

  it('labels only the worst-drop-off step as "maior abandono"', () => {
    renderWithProviders(<FunnelChart title="Funil de compra" result={result} />);

    // Aparece exatamente uma vez em todo o documento.
    expect(screen.getAllByText('maior abandono')).toHaveLength(1);

    // E está dentro da linha da etapa correta (add_to_cart), não em outra.
    const worstRow = screen.getByText('Adicionou ao carrinho').closest('li') as HTMLElement;
    expect(within(worstRow).getByText('maior abandono')).toBeInTheDocument();

    const firstRow = screen.getByText('Visualizou produto').closest('li') as HTMLElement;
    expect(within(firstRow).queryByText('maior abandono')).not.toBeInTheDocument();
  });

  it('shows the step conversion percentage when present', () => {
    renderWithProviders(<FunnelChart title="Funil de compra" result={result} />);
    // add_to_cart: 4000 / 10000 = 40,0%
    expect(screen.getByText(/40,0%/)).toBeInTheDocument();
    // add_payment_info: 2000 / 2400 ≈ 83,3%
    expect(screen.getByText(/83,3%/)).toBeInTheDocument();
  });

  it('omits the conversion percentage for the first step (null) instead of showing "null%"', () => {
    renderWithProviders(<FunnelChart title="Funil de compra" result={result} />);
    const firstRow = screen.getByText('Visualizou produto').closest('li') as HTMLElement;
    expect(firstRow.textContent).not.toMatch(/null/i);
    expect(firstRow.textContent).not.toMatch(/%/);
  });

  it('shows the empty state when the first step has zero users, without dividing by zero', () => {
    const zeroResult: FunnelResult = {
      ...result,
      steps: [{ ...result.steps[0]!, users: 0 }, ...result.steps.slice(1)],
    };
    renderWithProviders(<FunnelChart title="Funil de compra" result={zeroResult} />);
    expect(screen.getByText('Sem dados no período selecionado')).toBeInTheDocument();
    expect(screen.queryByText('maior abandono')).not.toBeInTheDocument();
  });

  it('shows the loading state', () => {
    renderWithProviders(<FunnelChart title="Funil de compra" result={undefined} isLoading />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows the error', () => {
    renderWithProviders(<FunnelChart title="Funil de compra" result={undefined} error={new Error('falha ao carregar funil')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('falha ao carregar funil');
  });

  it('renders the GA4 aggregation caveat note', () => {
    renderWithProviders(<FunnelChart title="Funil de compra" result={result} />);
    expect(screen.getByText(/não implica causalidade entre as etapas/)).toBeInTheDocument();
  });
});
