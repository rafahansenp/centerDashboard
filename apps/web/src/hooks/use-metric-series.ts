import { useQuery } from '@tanstack/react-query';
import { apiClient, type MetricQueryInput } from '../lib/api-client.js';
import { queryKeys } from '../lib/query-keys.js';

export function useMetricSeries(query: MetricQueryInput, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.series(query),
    queryFn: () => apiClient.queryMetric(query),
    enabled: options.enabled ?? true,
  });
}

/** Uma chamada HTTP para os N KPIs da tela, cada série com sua própria chave. */
export function useMetricBatch(queries: MetricQueryInput[], options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.batch(queries),
    queryFn: () => apiClient.queryBatch(queries),
    enabled: (options.enabled ?? true) && queries.length > 0,
  });
}
