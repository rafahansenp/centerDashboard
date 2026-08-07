import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { ProductsPage } from '../pages/ProductsPage.js';

function ranking(dimension: string, rows: Array<{ key: string; label: string; value: number }>) {
  return {
    dimension, from: '2026-03-01', to: '2026-03-15',
    total: rows.reduce((acc, row) => acc + row.value, 0), unit: 'currency',
    rows: rows.map((row) => ({ ...row, unit: 'currency', extra: { quantity: 1, orders: 1 }, share: 0.5 })),
  };
}

function mockEndpoints() {
  mswServer.use(
    http.post('/api/tools/commerce/top_products', () => HttpResponse.json(
      ranking('product', [{ key: 'CAM', label: 'Camiseta', value: 30000 }]))),
    http.post('/api/tools/commerce/top_categories', () => HttpResponse.json(
      ranking('category', [{ key: 'Vestuário', label: 'Vestuário', value: 30000 }]))),
    http.post('/api/tools/commerce/compare_products', () => HttpResponse.json({
      dimension: 'product',
      periodA: { from: '2026-02-01', to: '2026-02-28' },
      periodB: { from: '2026-03-01', to: '2026-03-15' },
      unit: 'currency',
      rows: [{ key: 'TEN', label: 'Tênis', valueA: 50000, valueB: 10000, delta: -40000, deltaRatio: -0.8 }],
    })),
    http.post('/api/tools/commerce/payment_method_performance', () => HttpResponse.json({
      from: '2026-03-01', to: '2026-03-15',
      methods: [{ method: 'pix', paidOrders: 20, failedOrders: 0, conversionRate: 1, revenueCents: 200000, averageTicketCents: 10000 }],
    })),
    http.post('/api/tools/commerce/failed_orders', () => HttpResponse.json({
      from: '2026-03-01', to: '2026-03-15', total: 1,
      orders: [{ numeroPedido: 'P9', statusLabel: 'Recusado', emittedAt: '2026-03-10T12:00:00Z', totalCents: 12000, paymentMethod: 'cartao' }],
    })),
  );
}

describe('ProductsPage', () => {
  it('shows the top products ranking', async () => {
    mockEndpoints();
    renderWithProviders(<ProductsPage today="2026-03-15" />, { route: '/produtos' });
    await waitFor(() => expect(screen.getByRole('cell', { name: 'Camiseta' })).toBeInTheDocument());
  });

  it('shows the top categories ranking', async () => {
    mockEndpoints();
    renderWithProviders(<ProductsPage today="2026-03-15" />, { route: '/produtos' });
    await waitFor(() => expect(screen.getByRole('cell', { name: 'Vestuário' })).toBeInTheDocument());
  });

  it('highlights the product that fell the most', async () => {
    mockEndpoints();
    renderWithProviders(<ProductsPage today="2026-03-15" />, { route: '/produtos' });
    await waitFor(() => expect(screen.getByText('Tênis')).toBeInTheDocument());
    expect(screen.getByText(/-80,0%/)).toBeInTheDocument();
  });

  it('lists the failed orders', async () => {
    mockEndpoints();
    renderWithProviders(<ProductsPage today="2026-03-15" />, { route: '/produtos' });
    await waitFor(() => expect(screen.getByText('P9')).toBeInTheDocument());
  });

  it('shows the payment method conversion', async () => {
    mockEndpoints();
    renderWithProviders(<ProductsPage today="2026-03-15" />, { route: '/produtos' });
    await waitFor(() => expect(screen.getByText('pix')).toBeInTheDocument());
    expect(screen.getByText('100,0%')).toBeInTheDocument();
  });
});
