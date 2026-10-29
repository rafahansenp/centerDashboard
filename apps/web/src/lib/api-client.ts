export type { MetricSource } from './viz-colors.js';
import type { MetricSource } from './viz-colors.js';

export type MetricUnit = 'count' | 'currency' | 'ratio' | 'duration';
export type Granularity = 'day' | 'week' | 'month';

export interface MetricDescriptor {
  id: string; label: string; description: string;
  source: MetricSource; unit: MetricUnit; dimensions: string[];
}

export interface MetricPoint { date: string; value: number; group?: string }

export interface MetricSeries {
  metricId: string; source: MetricSource; unit: MetricUnit;
  granularity: Granularity; total: number; points: MetricPoint[];
}

/** O cliente NUNCA envia tenant — ele vem do JWT no servidor. */
export interface MetricQueryInput {
  metricId: string; from: string; to: string; granularity: Granularity;
  filters?: Record<string, string>; groupBy?: string;
}

export interface RankingRow {
  key: string; label: string; value: number; unit: MetricUnit;
  extra: Record<string, number>;
  /**
   * Ausente quando a participação não faz sentido para aquele ranking. Uma
   * média ou uma taxa não é aditiva: somar as linhas não dá um todo, então
   * `valor / soma` não é uma proporção de coisa nenhuma. Os rankings desse
   * tipo (ticket médio por canal, taxa de recompra, conversão por dispositivo,
   * rejeição por página) omitem o campo em vez de devolver um número
   * inventado.
   */
  share?: number;
}

export interface RankingResult {
  dimension: string; from: string; to: string;
  /**
   * Ausente quando não existe um total inequívoco — ou porque somar as linhas
   * não significa nada (rankings de taxa/média, ver `RankingRow.share`), ou
   * porque a ferramenta não expõe um conceito de total. Omitir é deliberado:
   * um número errado aqui é pior do que nenhum.
   */
  total?: number;
  unit: MetricUnit; rows: RankingRow[];
}

export interface FunnelResult {
  from: string; to: string;
  steps: Array<{ key: string; label: string; users: number; stepConversion: number | null; dropOff: number }>;
  worstStepKey: string | null;
  overallConversion: number;
  identifiesUsers: boolean;
  note: string;
}

export interface CorrelationResult {
  metricA: { id: string; unit: MetricUnit; total: number };
  metricB: { id: string; unit: MetricUnit; total: number };
  from: string; to: string; granularity: Granularity; buckets: number;
  coefficient: number | null;
  strength: string; direction: string;
  series: Array<{ date: string; valueA: number; valueB: number }>;
  caveat: string;
}

export interface AgentMessageView { role: 'user' | 'assistant'; content: string }
export interface AgentConversationView { conversationId: string; messages: AgentMessageView[] }
export interface AgentAskResult { conversationId: string; reply: string }

export type IntegrationKind =
  | 'COMMERCE' | 'WEB_ANALYTICS' | 'APP_ANALYTICS' | 'PLAY_STORE' | 'APP_STORE' | 'SPRINT_BOARD';
export type IntegrationStatus = 'PENDING' | 'OK' | 'ERROR' | 'DISABLED';

export interface IntegrationStatusItem {
  kind: IntegrationKind;
  provider: string;
  status: IntegrationStatus;
  lastSyncedAt: string | null;
}

export interface IntegrationsView {
  integrations: IntegrationStatusItem[];
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'center.token';

export function setAuthToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    // Token expirado: limpamos aqui para que o guard redirecione sem cada tela
    // ter de tratar 401 individualmente.
    if (response.status === 401) setAuthToken(null);
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(response.status, body.message ?? `requisição falhou (${response.status})`);
  }

  return (await response.json()) as T;
}

export const apiClient = {
  login(email: string, password: string) {
    return request<{ token: string; user: { id: string; name: string; email: string; role: string } }>(
      '/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) },
    );
  },

  async getCatalog(): Promise<MetricDescriptor[]> {
    return (await request<{ metrics: MetricDescriptor[] }>('/api/metrics/catalog')).metrics;
  },

  queryMetric(query: MetricQueryInput): Promise<MetricSeries> {
    return request('/api/metrics/query', { method: 'POST', body: JSON.stringify(query) });
  },

  async queryBatch(queries: MetricQueryInput[]): Promise<MetricSeries[]> {
    return (await request<{ series: MetricSeries[] }>('/api/metrics/batch', {
      method: 'POST', body: JSON.stringify({ queries }),
    })).series;
  },

  callTool<T>(source: MetricSource, name: string, args: Record<string, unknown>): Promise<T> {
    return request(`/api/tools/${source}/${name}`, { method: 'POST', body: JSON.stringify(args) });
  },

  correlate(input: {
    metricIdA: string; metricIdB: string; from: string; to: string; granularity: Granularity;
  }): Promise<CorrelationResult> {
    return request('/api/analysis/correlate', { method: 'POST', body: JSON.stringify(input) });
  },

  appVersionImpact(input: { version: string; releaseDate: string; windowDays?: number }) {
    return request<Record<string, unknown>>('/api/analysis/app-version-impact', {
      method: 'POST', body: JSON.stringify(input),
    });
  },

  getAgentConversation(): Promise<AgentConversationView> {
    return request('/api/agent/conversation');
  },

  askAgent(message: string): Promise<AgentAskResult> {
    return request('/api/agent/ask', { method: 'POST', body: JSON.stringify({ message }) });
  },

  getIntegrations(): Promise<IntegrationsView> {
    return request('/api/settings/integrations');
  },
};
