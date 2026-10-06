import { resolvePreset, useFilters, type PeriodPreset } from '../../hooks/use-filters.js';

const PRESETS: Array<{ id: PeriodPreset; label: string }> = [
  { id: 'today', label: 'Hoje' },
  { id: 'last7', label: '7 dias' },
  { id: 'last30', label: '30 dias' },
  { id: 'last90', label: '90 dias' },
  { id: 'monthToDate', label: 'Mês atual' },
  { id: 'lastMonth', label: 'Mês passado' },
];

function formatBr(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

export function PeriodPicker({ today }: { today: string }) {
  const { filters, applyPreset } = useFilters(today);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Período" className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => {
          const resolved = resolvePreset(preset.id, today);
          const active = resolved.from === filters.from && resolved.to === filters.to;
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={active}
              onClick={() => applyPreset(preset.id)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                active ? 'bg-accent text-white' : 'hover:bg-white/10'
              }`}
              style={active ? undefined : { color: 'var(--text-secondary)' }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      {/* O intervalo resolvido fica sempre visível: "30 dias" sozinho é ambíguo. */}
      <span className="text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
        {formatBr(filters.from)} – {formatBr(filters.to)}
      </span>
    </div>
  );
}
