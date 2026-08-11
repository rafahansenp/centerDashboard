import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  MetricDescriptorSchema, MetricSeriesSchema, MetricSourceSchema,
  type MetricDescriptor, type MetricQuery, type MetricSeries, type MetricSource,
} from '@center/shared';

export interface McpServerConfig {
  source: MetricSource;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConnection {
  source: MetricSource;
  client: Client;
}

export class McpToolError extends Error {
  constructor(public readonly source: MetricSource, public readonly toolName: string, message: string) {
    super(`[${source}.${toolName}] ${message}`);
    this.name = 'McpToolError';
  }
}

interface RawToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

/** `commerce.revenue` → `commerce`. Roteamento sem estado, derivado do id. */
export function sourceOf(metricId: string): MetricSource {
  const parsed = MetricSourceSchema.safeParse(metricId.split('.')[0]);
  if (!parsed.success || !metricId.includes('.')) {
    throw new Error(`metricId inválido: "${metricId}" (esperado "<source>.<nome>")`);
  }
  return parsed.data;
}

export class McpPool {
  private constructor(private readonly connections: Map<MetricSource, Client>) {}

  static fromConnections(connections: McpConnection[]): McpPool {
    return new McpPool(new Map(connections.map((c) => [c.source, c.client])));
  }

  static async spawn(configs: McpServerConfig[]): Promise<McpPool> {
    const connections = await Promise.all(
      configs.map(async (config): Promise<McpConnection> => {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          // NUNCA repassar `process.env` inteiro: o processo pai carrega
          // PII_PEPPER, CREDENTIALS_ENCRYPTION_KEY, JWT_SECRET e os tokens de
          // WhatsApp/Anthropic. Um MCP server (e qualquer dependência
          // transitiva dele) só precisa do que o chamador entrega
          // explicitamente em `config.env` — é o que torna real o escopo por
          // servidor declarado nos composition roots. `getDefaultEnvironment()`
          // é a allowlist do próprio SDK (PATH, HOME e afins), usada por
          // padrão quando `env` é omitido; passar `env` opta por fora dela, e
          // por isso ela é reintroduzida aqui de propósito.
          env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
        });
        const client = new Client({ name: `center-pool-${config.source}`, version: '1.0.0' });
        await client.connect(transport);
        return { source: config.source, client };
      }),
    );
    return McpPool.fromConnections(connections);
  }

  private clientFor(source: MetricSource): Client {
    const client = this.connections.get(source);
    if (!client) throw new Error(`nenhum servidor MCP conectado para a fonte "${source}"`);
    return client;
  }

  async callTool<T>(source: MetricSource, name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await this.clientFor(source).callTool({ name, arguments: args })) as RawToolResult;

    if (result.isError) {
      const text = result.content?.map((part) => part.text ?? '').join(' ').trim();
      throw new McpToolError(source, name, text || 'erro desconhecido');
    }
    if (result.structuredContent === undefined) {
      throw new McpToolError(source, name, 'resposta sem structuredContent');
    }
    return result.structuredContent as T;
  }

  /** Um server offline não derruba o catálogo dos demais. */
  async listMetrics(): Promise<MetricDescriptor[]> {
    const results = await Promise.allSettled(
      [...this.connections.keys()].map(async (source) => {
        const payload = await this.callTool<{ metrics: unknown[] }>(source, 'list_metrics', {});
        return payload.metrics.map((m) => MetricDescriptorSchema.parse(m));
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<MetricDescriptor[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);
  }

  async queryMetric(query: MetricQuery): Promise<MetricSeries> {
    const payload = await this.callTool<unknown>(
      sourceOf(query.metricId), 'query_metric', query as unknown as Record<string, unknown>,
    );
    return MetricSeriesSchema.parse(payload);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((client) => client.close()));
    this.connections.clear();
  }
}
