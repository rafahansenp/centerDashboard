import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { OverviewPage } from '../pages/OverviewPage.js';

function seriesFor(metricId: string, total: number) {
  const source = metricId.startsWith('commerce') ? 'commerce' : metricId.startsWith('firebase') ? 'firebase' : 'ga4';
  const unit = metricId === 'commerce.revenue' || metricId === 'commerce.average_ticket' ? 'currency' : 'count';
  return {
    metricId, source, unit, granularity: 'day', total,
    points: [{ date: '2026-03-14', value: total / 2 }, { date: '2026-03-15', value: total / 2 }],
  };
}

function mockEndpoints(batchHandler?: jest.Mock) {
  mswServer.use(
    http.post('/api/metrics/batch', async ({ request }) => {
      const body = (await request.json()) as { queries: Array<{ metricId: string }> };
      batchHandler?.(body);
      return HttpResponse.json({
        series: body.queries.map((q) => seriesFor(q.metricId, q.metricId === 'commerce.revenue' ? 480000 : 120)),
      });
    }),
    http.post('/api/tools/commerce/orders_by_status', () => HttpResponse.json({
      from: '2026-03-01', to: '2026-03-15',
      groups: [
        { group: 'PAID', label: 'Pago', orders: 40, revenueCents: 400000, share: 0.8 },
        { group: 'CANCELLED', label: 'Cancelado', orders: 6, revenueCents: 60000, share: 0.12 },
        { group: 'PENDING_PAYMENT', label: 'Aguardando pagamento', orders: 4, revenueCents: 20000, share: 0.08 },
      ],
    })),
    // Pulso dos outros módulos (seção "Outros módulos") — ver OverviewPage.tsx.
    http.post('/api/metrics/query', () => HttpResponse.json(seriesFor('firebase.active_users', 58))),
    http.post('/api/tools/quality/feedback_by_category', () => HttpResponse.json({
      dimension: 'category', from: '2026-03-01', to: '2026-03-15', unit: 'count', total: 12, rows: [],
    })),
    http.post('/api/tools/sprint/sprint_summary', () => HttpResponse.json({
      from: '2026-03-01', to: '2026-03-15', sprintNumber: null, total: 9,
      byStatus: [{ key: 'ENTREGUE', label: 'Entregue', count: 9 }], byType: [], byArea: [],
    })),
  );
}

describe('OverviewPage', () => {
  it('renders one KPI card per headline metric', async () => {
    mockEndpoints();
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(screen.getByText('Faturamento')).toBeInTheDocument());
    for (const label of ['Pedidos', 'Ticket médio', 'Clientes novos']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('sends the filter period in every query', async () => {
    const handler = jest.fn();
    mockEndpoints(handler);
    renderWithProviders(<OverviewPage today="2026-03-15" />, {
      route: '/?from=2026-01-01&to=2026-01-31&granularity=day&sources=commerce,ga4',
    });
    await waitFor(() => expect(handler).toHaveBeenCalled());
    expect(handler.mock.calls[0][0].queries.every((q: { from: string }) => q.from === '2026-01-01')).toBe(true);
  });

  it('drops queries for a deselected source', async () => {
    const handler = jest.fn();
    mockEndpoints(handler);
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/?sources=commerce' });
    await waitFor(() => expect(handler).toHaveBeenCalled());
    const ids = handler.mock.calls[0][0].queries.map((q: { metricId: string }) => q.metricId);
    expect(ids.every((id: string) => id.startsWith('commerce.'))).toBe(true);
  });

  it('refetches when the user picks another period', async () => {
    const handler = jest.fn();
    mockEndpoints(handler);
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: '7 dias' }));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler.mock.calls[1][0].queries[0].from).toBe('2026-03-09');
  });

  it('shows the order status breakdown', async () => {
    mockEndpoints();
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(screen.getByText('Cancelado')).toBeInTheDocument());
    expect(screen.getByText('Aguardando pagamento')).toBeInTheDocument();
  });

  it('shows the error on every card when the batch fails', async () => {
    mswServer.use(
      http.post('/api/metrics/batch', () => HttpResponse.json({ message: 'fontes indisponíveis' }, { status: 502 })),
      http.post('/api/tools/commerce/orders_by_status', () => HttpResponse.json({ groups: [] })),
      http.post('/api/metrics/query', () => HttpResponse.json(seriesFor('firebase.active_users', 0))),
      http.post('/api/tools/quality/feedback_by_category', () => HttpResponse.json({
        dimension: 'category', from: '2026-03-01', to: '2026-03-15', unit: 'count', total: 0, rows: [],
      })),
      http.post('/api/tools/sprint/sprint_summary', () => HttpResponse.json({
        from: '2026-03-01', to: '2026-03-15', sprintNumber: null, total: 0, byStatus: [], byType: [], byArea: [],
      })),
    );
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('fontes indisponíveis');
  });
});
