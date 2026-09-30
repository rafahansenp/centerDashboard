import { useFilters } from '../hooks/use-filters.js';
import { useTool } from '../hooks/use-tool.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { RankingTable } from '../components/charts/RankingTable.js';
import type { RankingResult } from '../lib/api-client.js';

interface RatingTrendResult {
  platform: string; from: string; to: string;
  points: Array<{ date: string; averageRating: number; ratingCount: number }>;
  current: { averageRating: number; ratingCount: number; capturedAt: string } | null;
  previous: { averageRating: number; capturedAt: string } | null;
}

const percent = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'always',
});

/**
 * Cartão de nota da loja — não reaproveita `KpiCard` porque nota (1 a 5, duas
 * casas) não é nenhuma das quatro unidades de `formatMetricValue` (count
 * arredondaria para inteiro e perderia a casa decimal que diferencia 4.3 de 4.4).
 */
function RatingCard({ label, data, isLoading, error }: {
  label: string; data: RatingTrendResult | undefined; isLoading: boolean; error: Error | null;
}) {
  const current = data?.current ?? null;
  const previous = data?.previous ?? null;
  const hasDelta = current !== null && previous !== null;
  const deltaRatio = hasDelta ? ((current.averageRating - previous.averageRating) / previous.averageRating) * 100 : 0;
  const rising = deltaRatio >= 0;

  return (
    <div className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
      <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</p>
      {isLoading ? (
        <div role="status" className="mt-2 h-8 w-24 animate-pulse rounded" style={{ backgroundColor: 'var(--gridline)' }}>
          <span className="sr-only">Carregando {label}</span>
        </div>
      ) : error ? (
        <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--critical)' }}>{error.message}</p>
      ) : current === null ? (
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Sem snapshot no período</p>
      ) : (
        <>
          <p className="mt-1 text-3xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            {current.averageRating.toFixed(2)} ★
          </p>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>{current.ratingCount.toLocaleString('pt-BR')} avaliações</p>
          {hasDelta ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm">
              <span aria-hidden="true" style={{ color: rising ? 'var(--good)' : 'var(--critical)' }}>{rising ? '▲' : '▼'}</span>
              <span className="tabular-nums" style={{ color: rising ? 'var(--good)' : 'var(--critical)' }}>{percent.format(deltaRatio)}%</span>
              <span style={{ color: 'var(--text-muted)' }}>{rising ? 'de aumento' : 'de queda'} vs. snapshot anterior</span>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function AppQualityPage({ today }: { today: string }) {
  const { filters } = useFilters(today);
  const period = { from: filters.from, to: filters.to };

  const android = useTool<RatingTrendResult>('quality', 'rating_trend', { ...period, platform: 'ANDROID' });
  const ios = useTool<RatingTrendResult>('quality', 'rating_trend', { ...period, platform: 'IOS' });
  const feedback = useTool<RankingResult>('quality', 'feedback_by_category', period);

  const asError = (value: unknown) => (value instanceof Error ? value : null);

  return (
    <div className="space-y-6">
      <PeriodPicker today={today} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <RatingCard label="Nota — Android" data={android.data} isLoading={android.isLoading} error={asError(android.error)} />
        <RatingCard label="Nota — iOS" data={ios.data} isLoading={ios.isLoading} error={asError(ios.error)} />
      </div>

      <RankingTable
        title="Feedback por categoria"
        description="Reviews da loja e feedback do painel de marketplace, no período."
        result={feedback.data}
        isLoading={feedback.isLoading}
        error={asError(feedback.error)}
      />
    </div>
  );
}
