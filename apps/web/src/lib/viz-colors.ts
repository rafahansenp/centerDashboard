export type MetricSource = 'commerce' | 'ga4' | 'behavior' | 'firebase' | 'quality' | 'sprint';

/**
 * A cor segue a ENTIDADE (a fonte), nunca a posição na lista. Se um filtro
 * esconde o GA4, Commerce mantém exatamente a mesma cor.
 */
export const SERIES_SLOT_BY_SOURCE: Record<MetricSource, 1 | 2 | 3 | 4 | 5 | 6> = {
  commerce: 1,
  ga4: 2,
  behavior: 3,
  firebase: 4,
  quality: 5,
  sprint: 6,
};

/**
 * Referência à variável CSS, não um hex nem um nome de classe.
 *
 * Passada direto para `stroke`/`fill` do Recharts e para `style` de swatches:
 * o navegador resolve `var(--viz-1)` no momento da pintura, então a troca entre
 * claro e escuro acontece sem re-render e sem duplicar componente.
 */
export const SERIES_COLOR_BY_SOURCE: Record<MetricSource, string> = {
  commerce: 'var(--viz-1)',
  ga4: 'var(--viz-2)',
  behavior: 'var(--viz-3)',
  firebase: 'var(--viz-4)',
  quality: 'var(--viz-5)',
  sprint: 'var(--viz-6)',
};

/** Slots por posição, para séries que não são "por fonte" (ex.: campanhas). */
export const SERIES_COLOR_SLOTS = [
  'var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)',
] as const;

export const SOURCE_LABEL: Record<MetricSource, string> = {
  commerce: 'Loja (Uappi)',
  ga4: 'Analytics',
  behavior: 'Comportamento',
  firebase: 'App (Firebase)',
  quality: 'Qualidade',
  sprint: 'Sprint',
};
