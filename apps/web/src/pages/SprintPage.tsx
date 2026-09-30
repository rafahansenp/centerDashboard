import { useFilters } from '../hooks/use-filters.js';
import { useTool } from '../hooks/use-tool.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { CategoryLineChart } from '../components/charts/CategoryLineChart.js';
import { SERIES_COLOR_SLOTS } from '../lib/viz-colors.js';
import { formatBucketLabel } from '../lib/format.js';

interface TrendPoint { month: string; type: string; label: string; count: number }
interface TrendResult { from: string; to: string; points: TrendPoint[] }

interface SprintCycleRow {
  sprintNumber: number;
  totalTasks: number;
  planned: number;
  carriedFromPrevious: number;
  additionalTasks: number;
  completed: number;
  carriedToNext: number;
  bugfixTest: number;
  bugfixProduction: number;
  startDate: string | null;
  endDate: string | null;
  correctionsCount: number;
  corrections: Array<{ title: string }>;
}
interface CyclesResult { cycles: SprintCycleRow[] }

/** Mesma ordem de `CHART_TYPE_LABEL` em packages/mcp-sprint/src/trend.ts. */
const CHART_CATEGORIES: Array<{ type: string; label: string }> = [
  { type: 'MODULO', label: 'Tasks' },
  { type: 'MELHORIA', label: 'Melhorias' },
  { type: 'BUGFIX', label: 'Análises' },
  { type: 'CORRECAO', label: 'Correção' },
];

const CARD_COUNT = 8;

function formatBr(isoDate: string | null): string {
  if (!isoDate) return '—';
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

/** Uma linha "N rótulo" — mesmo formato da tabela de referência do time. */
function CountLine({ value, label, emphasis = false }: { value: number; label: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-1 text-sm">
      <span
        className="w-8 shrink-0 text-right tabular-nums"
        style={{ color: emphasis ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: emphasis ? 600 : 400 }}
      >
        {value}
      </span>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
    </div>
  );
}

function SprintCycleCard({ cycle }: { cycle: SprintCycleRow }) {
  return (
    <section
      className="rounded-lg border p-4"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
      aria-label={`Sprint ${cycle.sprintNumber}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Sprint {cycle.sprintNumber}
        </h3>
        {cycle.startDate && cycle.endDate ? (
          <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {formatBr(cycle.startDate)} – {formatBr(cycle.endDate)}
          </span>
        ) : null}
      </div>

      <div className="mt-2 divide-y" style={{ borderColor: 'var(--gridline)' }}>
        <CountLine value={cycle.totalTasks} label="tasks totais" emphasis />
        <CountLine value={cycle.planned} label="planejadas" />
        <CountLine value={cycle.carriedFromPrevious} label="vieram da sprint passada" />
        <CountLine value={cycle.additionalTasks} label="task adicionais" />
        <CountLine value={cycle.completed} label="foram feitas" emphasis />
        <CountLine value={cycle.carriedToNext} label="vão pra próxima sprint" />
        <CountLine value={cycle.bugfixTest} label="bugfix (em ambiente de teste)" />
        <CountLine value={cycle.bugfixProduction} label="bugfix (em produção)" />
        <CountLine value={cycle.correctionsCount} label="tasks de correções" />
      </div>

      {cycle.corrections.length > 0 ? (
        <ul className="mt-2 space-y-1 pl-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {cycle.corrections.map((correction, index) => (
            <li key={`${cycle.sprintNumber}-${index}`}>· {correction.title}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function SprintPage({ today }: { today: string }) {
  const { filters } = useFilters(today);
  const period = { from: filters.from, to: filters.to };

  const trend = useTool<TrendResult>('sprint', 'sprint_type_trend', period);
  const cycles = useTool<CyclesResult>('sprint', 'sprint_cycles', { limit: 24 });

  const trendError = trend.error instanceof Error ? trend.error : null;
  const cyclesError = cycles.error instanceof Error ? cycles.error : null;

  const seriesFor = (type: string) => {
    const rows = (trend.data?.points ?? []).filter((p) => p.type === type);
    return rows.map((row) => ({ x: formatBucketLabel(`${row.month}-01`, 'month'), y: row.count }));
  };

  const allCycles = cycles.data?.cycles ?? [];
  const totalsSeries = allCycles.map((cycle) => ({ x: String(cycle.sprintNumber), y: cycle.totalTasks }));
  const recentCycles = [...allCycles].reverse().slice(0, CARD_COUNT);

  return (
    <div className="space-y-6">
      <PeriodPicker today={today} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CHART_CATEGORIES.map((category, index) => (
          <CategoryLineChart
            key={category.type}
            title={category.label}
            points={seriesFor(category.type)}
            color={SERIES_COLOR_SLOTS[index] ?? SERIES_COLOR_SLOTS[0]}
            height={150}
            isLoading={trend.isLoading}
            error={trendError}
          />
        ))}
      </div>

      <CategoryLineChart
        title="Tasks por sprint"
        description="Total de tarefas de cada sprint, na ordem em que aconteceram."
        points={totalsSeries}
        color={SERIES_COLOR_SLOTS[0] ?? '#2a78d6'}
        height={220}
        isLoading={cycles.isLoading}
        error={cyclesError}
      />

      <div>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Contagem por sprint
        </h2>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          As {Math.min(CARD_COUNT, recentCycles.length)} sprints mais recentes, da mais nova para a mais antiga.
        </p>

        {cyclesError ? (
          <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--critical)' }}>{cyclesError.message}</p>
        ) : cycles.isLoading ? (
          <div role="status" className="mt-3 h-48 animate-pulse rounded-md" style={{ backgroundColor: 'var(--gridline)' }}>
            <span className="sr-only">Carregando sprints</span>
          </div>
        ) : recentCycles.length === 0 ? (
          <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Nenhuma sprint registrada</p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {recentCycles.map((cycle) => (
              <SprintCycleCard key={cycle.sprintNumber} cycle={cycle} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
