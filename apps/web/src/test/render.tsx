import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

export function renderWithProviders(
  ui: ReactElement,
  options: { route?: string } = {},
): RenderResult {
  const queryClient = new QueryClient({
    // Sem retry nos testes: um erro precisa aparecer de imediato, não depois
    // de três tentativas silenciosas.
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options.route ?? '/']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
