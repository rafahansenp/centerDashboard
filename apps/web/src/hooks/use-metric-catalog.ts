import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/api-client.js';
import { queryKeys } from '../lib/query-keys.js';

export function useMetricCatalog() {
  return useQuery({
    queryKey: queryKeys.catalog(),
    queryFn: () => apiClient.getCatalog(),
    // O catálogo praticamente não muda; recarregá-lo a cada navegação é desperdício.
    staleTime: 10 * 60_000,
  });
}
