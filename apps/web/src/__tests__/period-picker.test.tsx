import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { SourceFilter } from '../components/filters/SourceFilter.js';

describe('PeriodPicker', () => {
  it('exposes every preset as a button', () => {
    renderWithProviders(<PeriodPicker today="2026-03-15" />);
    for (const label of ['Hoje', '7 dias', '30 dias', '90 dias', 'Mês atual', 'Mês passado']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the active preset with aria-pressed', async () => {
    renderWithProviders(<PeriodPicker today="2026-03-15" />, { route: '/' });
    await userEvent.click(screen.getByRole('button', { name: 'Mês passado' }));
    expect(screen.getByRole('button', { name: 'Mês passado' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '30 dias' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the resolved range as text so it is never ambiguous', async () => {
    renderWithProviders(<PeriodPicker today="2026-03-15" />, { route: '/' });
    await userEvent.click(screen.getByRole('button', { name: 'Mês passado' }));
    expect(screen.getByText('01/02/2026 – 28/02/2026')).toBeInTheDocument();
  });
});

describe('SourceFilter', () => {
  it('renders one checkbox per source, checked by default', () => {
    renderWithProviders(<SourceFilter today="2026-03-15" />, { route: '/' });
    expect(screen.getByRole('checkbox', { name: 'Loja (Uappi)' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Analytics' })).toBeChecked();
  });

  it('unchecking a source removes it from the filters', async () => {
    renderWithProviders(<SourceFilter today="2026-03-15" />, { route: '/' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    expect(screen.getByRole('checkbox', { name: 'Analytics' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Loja (Uappi)' })).toBeChecked();
  });

  it('refuses to uncheck the last remaining source', async () => {
    renderWithProviders(<SourceFilter today="2026-03-15" />, { route: '/?sources=commerce' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Loja (Uappi)' }));
    expect(screen.getByRole('checkbox', { name: 'Loja (Uappi)' })).toBeChecked();
  });
});
