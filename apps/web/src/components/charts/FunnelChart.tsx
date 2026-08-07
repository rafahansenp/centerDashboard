import type { FunnelResult } from '../../lib/api-client.js';
import { formatMetricValue } from '../../lib/format.js';
import { SERIES_COLOR_SLOTS } from '../../lib/viz-colors.js';

interface FunnelChartProps {
  title: string;
  result: FunnelResult | undefined;
  isLoading?: boolean;
  error?: Error | null;
}

const percent = new Intl.NumberFormat('pt-BR', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
});

/**
 * O funil é desenhado com barras proporcionais ao primeiro passo, e a etapa de
 * maior abandono recebe um rótulo textual — não apenas cor — porque é
 * exatamente a informação que a pergunta procura.
 */
export function FunnelChart({ title, result, isLoading = false, error = null }: FunnelChartProps) {
  const firstUsers = result?.steps[0]?.users ?? 0;

  return (
    <section
      className="rounded-lg border p-4"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
      aria-label={title}
    >
      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>

      {isLoading ? (
        <div role="status" className="mt-3 h-48 animate-pulse rounded-md" style={{ backgroundColor: 'var(--gridline)' }}>
          <span className="sr-only">Carregando {title}</span>
        </div>
      ) : error ? (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--critical)' }}>{error.message}</p>
      ) : !result || firstUsers === 0 ? (
        <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Sem dados no período selecionado
        </p>
      ) : (
        <>
          <ol className="mt-3 space-y-2">
            {result.steps.map((step) => {
              const worst = step.key === result.worstStepKey;
              return (
                <li key={step.key}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span style={{ color: 'var(--text-primary)' }}>
                      {step.label}
                      {worst ? (
                        <span className="ml-2 text-xs font-medium" style={{ color: 'var(--critical)' }}>
                          maior abandono
                        </span>
                      ) : null}
                    </span>
                    <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                      {formatMetricValue(step.users, 'count')}
                      {step.stepConversion !== null ? ` · ${percent.format(step.stepConversion)}` : ''}
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-sm" style={{ backgroundColor: 'var(--gridline)' }}>
                    {/* Uma série só, então o slot posicional 1 — não há
                        identidade de fonte para preservar aqui. */}
                    <div
                      className="h-2 rounded-sm"
                      style={{
                        width: `${Math.max(2, (step.users / firstUsers) * 100)}%`,
                        backgroundColor: SERIES_COLOR_SLOTS[0],
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            Conversão total: {percent.format(result.overallConversion)}. {result.note}
          </p>
        </>
      )}
    </section>
  );
}
