import { useFilters, resolvePreset } from '../hooks/use-filters.js';
import { useTool } from '../hooks/use-tool.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { RankingTable } from '../components/charts/RankingTable.js';
import { formatMetricValue } from '../lib/format.js';
import type { RankingResult } from '../lib/api-client.js';

interface ComparisonResult {
  rows: Array<{ key: string; label: string; valueA: number; valueB: number; delta: number; deltaRatio: number | null }>;
}

interface PaymentResult {
  methods: Array<{ method: string; paidOrders: number; failedOrders: number; conversionRate: number; averageTicketCents: number }>;
}

interface FailedOrdersResult {
  total: number;
  orders: Array<{ numeroPedido: string; statusLabel: string; emittedAt: string; totalCents: number; paymentMethod: string | null }>;
}

const percent = new Intl.NumberFormat('pt-BR', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero',
});
const plainPercent = new Intl.NumberFormat('pt-BR', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
});

export function ProductsPage({ today }: { today: string }) {
  const { filters } = useFilters(today);
  const period = { from: filters.from, to: filters.to };

  const topProducts = useTool<RankingResult>('commerce', 'top_products', { ...period, limit: 10 });
  const topCategories = useTool<RankingResult>('commerce', 'top_categories', { ...period, limit: 10 });
  const payments = useTool<PaymentResult>('commerce', 'payment_method_performance', period);
  const failed = useTool<FailedOrdersResult>('commerce', 'failed_orders', { ...period, limit: 10 });

  // A comparação usa o mês anterior como referência — é o que "caiu em vendas"
  // significa para quem pergunta.
  const previousMonth = resolvePreset('lastMonth', filters.from);
  const comparison = useTool<ComparisonResult>('commerce', 'compare_products', {
    periodA: { from: previousMonth.from, to: previousMonth.to },
    periodB: period,
    limit: 10,
  });

  const asError = (value: unknown) => (value instanceof Error ? value : null);

  return (
    <div className="space-y-6">
      <PeriodPicker today={today} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RankingTable
          title="Produtos mais vendidos"
          description="Por faturamento no período."
          result={topProducts.data}
          isLoading={topProducts.isLoading}
          error={asError(topProducts.error)}
        />
        <RankingTable
          title="Categorias mais vendidas"
          description="Por faturamento no período."
          result={topCategories.data}
          isLoading={topCategories.isLoading}
          error={asError(topCategories.error)}
        />
      </div>

      <section className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
        aria-label="Maiores quedas em vendas">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Maiores quedas em vendas</h3>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          Comparado com {previousMonth.from} a {previousMonth.to}.
        </p>
        {asError(comparison.error) ? (
          <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--critical)' }}>
            {(comparison.error as Error).message}
          </p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr>
                {['Produto', 'Antes', 'Agora', 'Variação'].map((column) => (
                  <th key={column} scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(comparison.data?.rows ?? []).map((row) => (
                <tr key={row.key}>
                  <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{row.label}</td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                    {formatMetricValue(row.valueA, 'currency')}
                  </td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                    {formatMetricValue(row.valueB, 'currency')}
                  </td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{
                    borderColor: 'var(--gridline)',
                    color: row.delta < 0 ? 'var(--critical)' : 'var(--good)',
                  }}>
                    {row.deltaRatio === null ? 'novo' : percent.format(row.deltaRatio)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
          aria-label="Conversão por meio de pagamento">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Conversão por meio de pagamento</h3>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr>
                {['Meio', 'Concluídos', 'Falhos', 'Conversão'].map((column) => (
                  <th key={column} scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(payments.data?.methods ?? []).map((method) => (
                <tr key={method.method}>
                  <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{method.method}</td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>{method.paidOrders}</td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>{method.failedOrders}</td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                    {plainPercent.format(method.conversionRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
          aria-label="Compras que falharam">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Compras que falharam {failed.data ? `(${failed.data.total})` : ''}
          </h3>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr>
                {['Pedido', 'Situação', 'Valor'].map((column) => (
                  <th key={column} scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(failed.data?.orders ?? []).map((order) => (
                <tr key={order.numeroPedido}>
                  <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{order.numeroPedido}</td>
                  <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{order.statusLabel}</td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                    {formatMetricValue(order.totalCents, 'currency')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
