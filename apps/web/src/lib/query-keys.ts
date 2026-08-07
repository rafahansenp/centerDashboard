import type { MetricQueryInput, MetricSource } from './api-client.js';

/**
 * Chaves hierárquicas: invalidar `['metrics']` invalida tudo de métricas.
 * O objeto entra inteiro na chave — o TanStack Query o serializa de forma
 * estável, então a ordem das propriedades não gera cache duplicado.
 */
export const queryKeys = {
  catalog: () => ['metrics', 'catalog'] as const,
  series: (query: MetricQueryInput) => ['metrics', 'series', query] as const,
  batch: (queries: MetricQueryInput[]) => ['metrics', 'batch', queries] as const,
  tool: (source: MetricSource, name: string, args: Record<string, unknown>) =>
    ['tool', source, name, args] as const,
  correlate: (input: Record<string, unknown>) => ['analysis', 'correlate', input] as const,
};
