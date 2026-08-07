import { useMemo } from 'react';
import { useFilters } from '../hooks/use-filters.js';
import { useMetricBatch } from '../hooks/use-metric-series.js';
import { useTool } from '../hooks/use-tool.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { SourceFilter } from '../components/filters/SourceFilter.js';
import { KpiCard } from '../components/charts/KpiCard.js';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart.js';
import type { MetricQueryInput, MetricSeries, MetricSource, MetricUnit } from '../lib/api-client.js';
import { formatMetricValue } from '../lib/format.js';

interface HeadlineMetric {
  metricId: string; source: MetricSource; label: string; unit: MetricUnit;
}

const HEADLINE_METRICS: HeadlineMetric[] = [
  { metricId: 'commerce.revenue', source: 'commerce', label: 'Faturamento', unit: 'currency' },
  { metricId: 'commerce.orders', source: 'commerce', label: 'Pedidos', unit: 'count' },
  { metricId: 'commerce.average_ticket', source: 'commerce', label: 'Ticket médio', unit: 'currency' },
  { metricId: 'commerce.new_customers', source: 'commerce', label: 'Clientes novos', unit: 'count' },
  { metricId: 'ga4.sessions', source: 'ga4', label: 'Sessões', unit: 'count' },
  { metricId: 'ga4.active_users', source: 'ga4', label: 'Usuários ativos', unit: 'count' },
];

interface StatusGroups {
  groups: Array<{ group: string; label: string; orders: number; revenueCents: number; share: number }>;
}

const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 });

export function OverviewPage({ today }: { today: string }) {
  const { filters } = useFilters(today);

  const visibleMetrics = HEADLINE_METRICS.filter((metric) => filters.sources.includes(metric.source));

  const queries = useMemo<MetricQueryInput[]>(
    () => visibleMetrics.map((metric) => ({
      metricId: metric.metricId, from: filters.from, to: filters.to, granularity: filters.granularity,
    })),
    // `visibleMetrics` deriva de `filters`; depender de `filters` basta e evita
    // recriar o array a cada render.
    [filters],
  );

  const { data, isLoading, error } = useMetricBatch(queries);
  const queryError = error instanceof Error ? error : null;

  const statusQuery = useTool<StatusGroups>('commerce', 'orders_by_status', {
    from: filters.from, to: filters.to,
  }, { enabled: filters.sources.includes('commerce') });

  const seriesById = new Map((data ?? []).map((series) => [series.metricId, series]));
  const pick = (ids: string[]): MetricSeries[] =>
    ids.map((id) => seriesById.get(id)).filter((series): series is MetricSeries => series !== undefined);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PeriodPicker today={today} />
        <SourceFilter today={today} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visibleMetrics.map((metric) => (
          <KpiCard
            key={metric.metricId}
            label={metric.label}
            unit={metric.unit}
            value={seriesById.get(metric.metricId)?.total ?? 0}
            isLoading={isLoading}
            error={queryError}
          />
        ))}
      </div>

      {/* Reais e contagem em gráficos separados: nunca dois eixos Y. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TimeSeriesChart
          title="Evolução do faturamento"
          description="Receita de pedidos com status de venda."
          seriesList={pick(['commerce.revenue'])}
          granularity={filters.granularity}
          unit="currency"
          isLoading={isLoading}
          error={queryError}
        />
        <TimeSeriesChart
          title="Volume"
          description="Pedidos e sessões no período."
          seriesList={pick(['commerce.orders', 'ga4.sessions'])}
          granularity={filters.granularity}
          unit="count"
          isLoading={isLoading}
          error={queryError}
        />
      </div>

      <section
        className="rounded-lg border p-4"
        style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
        aria-label="Situação dos pedidos"
      >
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Situação dos pedidos</h3>
        {statusQuery.error instanceof Error ? (
          <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--critical)' }}>
            {statusQuery.error.message}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {['Situação', 'Qtd. pedidos', 'Valor', 'Part.'].map((column) => (
                    <th key={column} scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                      style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(statusQuery.data?.groups ?? []).map((group) => (
                  <tr key={group.group}>
                    <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{group.label}</td>
                    <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                      {formatMetricValue(group.orders, 'count')}
                    </td>
                    <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                      {formatMetricValue(group.revenueCents, 'currency')}
                    </td>
                    <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>
                      {percent.format(group.share)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
