import { useQuery } from '@tanstack/react-query';
import { apiClient, type MetricSource } from '../lib/api-client.js';
import { queryKeys } from '../lib/query-keys.js';

export function useTool<T>(
  source: MetricSource,
  name: string,
  args: Record<string, unknown>,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.tool(source, name, args),
    queryFn: () => apiClient.callTool<T>(source, name, args),
    enabled: options.enabled ?? true,
  });
}
