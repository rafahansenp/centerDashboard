import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { assertDatasetName, toCompactDate } from './client.js';
import type { BigQueryEventsClientLike } from './interface.js';

const DEFAULT_LOOKBACK = 10;

/**
 * Total de compradores distintos no período — calculada isoladamente da query
 * de eventos precedentes (`buildPurchasePathSql`) porque essa segunda query só
 * produz linhas quando existe pelo menos um evento precedente dentro da janela
 * de lookback. Se todo comprador tiver a compra como seu evento mais antigo
 * capturado no período (ex.: janela estreita, cobertura do export começando
 * bem no início da sessão), `preceding`/`GROUP BY event_name` fica vazio e uma
 * subquery escalar acoplada a essa query nunca chega a aparecer em nenhuma
 * linha — o total seria lido como zero mesmo havendo compradores de verdade.
 * Por isso o total mora em sua própria query, que não depende do resultado da
 * outra.
 */
export function buildTotalBuyersSql(params: { dataset: string }): string {
  const dataset = assertDatasetName(params.dataset);

  return `
    SELECT COUNT(DISTINCT user_pseudo_id) AS buyers
    FROM \`${dataset}.events_*\`
    WHERE _TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact
      AND event_name = 'purchase'
  `;
}

/**
 * Para cada usuário que comprou, olha os N eventos imediatamente anteriores à
 * primeira compra e conta com que frequência cada tipo de evento aparece.
 *
 * `_TABLE_SUFFIX BETWEEN` é obrigatório: sem ele o BigQuery varre todo o
 * histórico do export, o que é lento e caro.
 */
export function buildPurchasePathSql(params: { dataset: string; lookback: number }): string {
  const dataset = assertDatasetName(params.dataset);
  const lookback = Math.trunc(params.lookback);

  return `
    WITH events AS (
      SELECT
        user_pseudo_id,
        event_name,
        event_timestamp
      FROM \`${dataset}.events_*\`
      WHERE _TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact
    ),
    first_purchase AS (
      SELECT user_pseudo_id, MIN(event_timestamp) AS purchase_ts
      FROM events
      WHERE event_name = 'purchase'
      GROUP BY user_pseudo_id
    ),
    preceding AS (
      SELECT
        e.user_pseudo_id,
        e.event_name,
        ROW_NUMBER() OVER (
          PARTITION BY e.user_pseudo_id ORDER BY e.event_timestamp DESC
        ) AS position
      FROM events e
      JOIN first_purchase p USING (user_pseudo_id)
      WHERE e.event_timestamp < p.purchase_ts
    )
    SELECT
      event_name,
      COUNT(DISTINCT user_pseudo_id) AS users,
      AVG(position) AS avg_position
    FROM preceding
    WHERE position <= ${lookback}
    GROUP BY event_name
    ORDER BY users DESC
    LIMIT 50
  `;
}

interface TotalBuyersRow {
  buyers: number | bigint;
}

interface PurchasePathRow {
  event_name: string;
  users: number | bigint;
  avg_position: number;
}

export function createEventsBeforePurchaseTool(client: BigQueryEventsClientLike): AnalysisTool {
  const InputSchema = z.object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    tenant: TenantContextSchema,
    eventosAnteriores: z.number().int().min(1).max(50).default(DEFAULT_LOOKBACK),
  });

  return {
    name: 'events_before_purchase',
    description:
      'Eventos que mais aparecem imediatamente antes de uma compra, com a frequência entre os ' +
      'compradores e a posição média na sequência. Use para "quais eventos antecedem uma compra". ' +
      'Frequência de 0 a 1: 0,95 significa que 95% dos compradores dispararam aquele evento antes. ' +
      'totalBuyers é a contagem de compradores distintos no período, não de eventos de compra.',
    inputSchema: {
      from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema,
      eventosAnteriores: z.number().optional(),
    },
    outputSchema: {
      from: z.string(), to: z.string(),
      totalBuyers: z.number(),
      events: z.array(z.object({
        evento: z.string(), usuarios: z.number(),
        frequencia: z.number(), posicaoMedia: z.number(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant, eventosAnteriores } = InputSchema.parse(args);

      const dataset = tenant.externalIds.ga4BigQueryDataset;
      if (!dataset) {
        throw new Error(
          `ga4BigQueryDataset não configurado para a organização "${tenant.organizationId}"`,
        );
      }

      const queryParams = { fromCompact: toCompactDate(from), toCompact: toCompactDate(to) };

      const [buyerRows, pathRows] = await Promise.all([
        client.query<TotalBuyersRow>(buildTotalBuyersSql({ dataset }), queryParams),
        client.query<PurchasePathRow>(
          buildPurchasePathSql({ dataset, lookback: eventosAnteriores }),
          queryParams,
        ),
      ]);

      // Contagem de compradores distintos, independente da query de eventos
      // precedentes (ver comentário em buildTotalBuyersSql) — nunca fica zerada
      // só porque a segunda query não retornou linhas.
      const totalBuyers = Number(buyerRows[0]?.buyers ?? 0);

      return {
        from, to, totalBuyers,
        events: pathRows
          .map((row) => ({
            evento: row.event_name,
            usuarios: Number(row.users),
            frequencia: totalBuyers === 0 ? 0 : Number(row.users) / totalBuyers,
            posicaoMedia: Number(row.avg_position),
          }))
          .sort((a, b) => b.frequencia - a.frequencia),
      };
    },
  };
}
