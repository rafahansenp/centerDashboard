import { useFilters } from '../../hooks/use-filters.js';
import { SERIES_COLOR_BY_SOURCE, SOURCE_LABEL } from '../../lib/viz-colors.js';
import type { MetricSource } from '../../lib/api-client.js';

const SOURCES: MetricSource[] = ['commerce', 'ga4'];

export function SourceFilter({ today }: { today: string }) {
  const { filters, setFilters } = useFilters(today);

  function toggle(source: MetricSource): void {
    const active = filters.sources.includes(source);
    // Desmarcar a última fonte deixaria a tela vazia sem explicação.
    if (active && filters.sources.length === 1) return;
    setFilters({
      sources: active
        ? filters.sources.filter((item) => item !== source)
        : [...filters.sources, source],
    });
  }

  return (
    <fieldset className="flex flex-wrap items-center gap-4">
      <legend className="sr-only">Fontes de dados</legend>
      {SOURCES.map((source) => (
        <label key={source} className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.sources.includes(source)}
            onChange={() => toggle(source)}
            className="h-4 w-4 rounded"
          />
          {/* Swatch ao lado do rótulo: a identidade nunca depende só da cor.
              A cor vai em `style`, não em classe — uma classe montada em runtime
              seria removida pelo Tailwind no build de produção. */}
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: SERIES_COLOR_BY_SOURCE[source] }}
          />
          <span style={{ color: 'var(--text-secondary)' }}>{SOURCE_LABEL[source]}</span>
        </label>
      ))}
    </fieldset>
  );
}
