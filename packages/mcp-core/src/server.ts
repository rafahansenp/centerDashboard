import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodRawShape } from 'zod';
import { MetricCatalogSchema, MetricQuerySchema, MetricSeriesSchema } from '@center/shared';
import { MetricNotFoundError, type MetricProvider } from './provider.js';

export { MetricNotFoundError };
export type { MetricProvider };

/**
 * Ferramenta de análise nomeada — rankings, funis, comparações. A segunda
 * família de ferramentas: o que não cabe em série temporal mora aqui.
 */
export interface AnalysisTool<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  outputSchema: ZodRawShape;
  handler: (args: TInput) => Promise<Record<string, unknown>>;
}

export interface CreateMetricServerOptions {
  name: string;
  version: string;
  provider?: MetricProvider;
  tools?: AnalysisTool[];
}

function ok(structured: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * Erros viram resultado-de-ferramenta, não exceção de transporte. O modelo
 * precisa conseguir ler a mensagem e decidir o que fazer; um crash de
 * transporte derrubaria a conversa inteira.
 */
function fail(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

export function createMetricServer(options: CreateMetricServerOptions): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });

  if (options.provider) {
    const provider = options.provider;

    server.registerTool(
      'list_metrics',
      {
        title: 'Listar métricas',
        description:
          'Lista as métricas disponíveis nesta fonte com unidade e dimensões filtráveis. ' +
          'Chame antes de query_metric quando não souber o metricId exato.',
        inputSchema: {},
        outputSchema: MetricCatalogSchema.shape,
      },
      async () => {
        try {
          return ok({ metrics: [...provider.descriptors] });
        } catch (error) {
          return fail(error);
        }
      },
    );

    server.registerTool(
      'query_metric',
      {
        title: 'Consultar métrica',
        description:
          'Série temporal de uma métrica em um intervalo. Datas em YYYY-MM-DD. ' +
          'Valores monetários voltam em CENTAVOS.',
        inputSchema: MetricQuerySchema.shape,
        outputSchema: MetricSeriesSchema.shape,
      },
      async (args) => {
        try {
          // Revalidamos: o SDK checa a forma, mas as regras de negócio
          // (regex de data, tenant obrigatório) ficam num lugar só.
          const query = MetricQuerySchema.parse(args);
          if (!provider.descriptors.some((d) => d.id === query.metricId)) {
            throw new MetricNotFoundError(query.metricId);
          }
          return ok(MetricSeriesSchema.parse(await provider.query(query)));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  for (const tool of options.tools ?? []) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          return ok(await tool.handler(args as never));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  return server;
}

export async function startStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
