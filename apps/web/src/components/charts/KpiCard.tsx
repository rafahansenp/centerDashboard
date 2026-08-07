import type { MetricUnit } from '../../lib/api-client.js';
import { formatMetricValue } from '../../lib/format.js';

interface KpiCardProps {
  label: string;
  value: number;
  unit: MetricUnit;
  previousValue?: number;
  isLoading?: boolean;
  error?: Error | null;
}

const percent = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'always',
});

/**
 * Número-herói sem gráfico. A variação carrega SEMPRE uma palavra ("aumento"
 * / "queda") além da cor — cor sozinha não é canal acessível.
 */
export function KpiCard({ label, value, unit, previousValue, isLoading = false, error = null }: KpiCardProps) {
  const hasDelta = previousValue !== undefined && previousValue !== 0;
  const deltaRatio = hasDelta ? ((value - previousValue) / Math.abs(previousValue)) * 100 : 0;
  const rising = deltaRatio >= 0;

  return (
    <div className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
      <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>

      {isLoading ? (
        <div role="status" className="mt-2 h-8 w-24 animate-pulse rounded" style={{ backgroundColor: 'var(--gridline)' }}>
          <span className="sr-only">Carregando {label}</span>
        </div>
      ) : error ? (
        <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--critical)' }}>{error.message}</p>
      ) : (
        <>
          <p className="mt-1 text-3xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            {formatMetricValue(value, unit)}
          </p>
          {hasDelta ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm">
              <span aria-hidden="true" style={{ color: rising ? 'var(--good)' : 'var(--critical)' }}>
                {rising ? '▲' : '▼'}
              </span>
              <span className="tabular-nums" style={{ color: rising ? 'var(--good)' : 'var(--critical)' }}>
                {percent.format(deltaRatio)}%
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {rising ? 'de aumento' : 'de queda'} vs. período anterior
              </span>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
