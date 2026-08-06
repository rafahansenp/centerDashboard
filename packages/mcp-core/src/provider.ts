import type { MetricDescriptor, MetricQuery, MetricSeries } from '@center/shared';

/** A única coisa que um server de métricas precisa implementar. */
export interface MetricProvider {
  readonly descriptors: readonly MetricDescriptor[];
  query(query: MetricQuery): Promise<MetricSeries>;
}

export class MetricNotFoundError extends Error {
  constructor(public readonly metricId: string) {
    super(`métrica desconhecida: "${metricId}"`);
    this.name = 'MetricNotFoundError';
  }
}
