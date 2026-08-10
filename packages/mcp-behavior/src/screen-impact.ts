import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { assertDatasetName, toCompactDate } from './client.js';
import type { BigQueryEventsClientLike } from './interface.js';

const CAVEAT =
  'Correlação não implica causa. A diferença mostra que os dois grupos se comportam de forma '
  + 'distinta, não que a tela causa a queda — quem chega nela pode já ter uma intenção de compra '
  + 'diferente do resto.';

/**
 * Divide os usuários do período em dois grupos — quem passou pela tela e quem
 * não passou — e compara a taxa de compra de cada um.
 *
 * O nome da tela vai como parâmetro nomeado; só o dataset é interpolado, e ele
 * passa por `assertDatasetName`.
 */
export function buildScreenImpactSql(params: { dataset: string }): string {
  const dataset = assertDatasetName(params.dataset);

  return `
    WITH events AS (
      SELECT
        user_pseudo_id,
        event_name,
        (SELECT value.string_value FROM UNNEST(event_params)
         WHERE key IN ('firebase_screen', 'screen_name', 'page_title')) AS screen
      FROM \`${dataset}.events_*\`
      WHERE _TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact
    ),
    per_user AS (
      SELECT
        user_pseudo_id,
        LOGICAL_OR(screen = @screenName) AS saw_screen,
        LOGICAL_OR(event_name = 'purchase') AS bought
      FROM events
      GROUP BY user_pseudo_id
    )
    SELECT
      saw_screen,
      COUNT(*) AS users,
      COUNTIF(bought) AS buyers
    FROM per_user
    GROUP BY saw_screen
  `;
}

interface ScreenImpactRow {
  saw_screen: boolean;
  users: number | bigint;
  buyers: number | bigint;
}

export function createScreenAbandonImpactTool(client: BigQueryEventsClientLike): AnalysisTool {
  const InputSchema = z.object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    tenant: TenantContextSchema,
    tela: z.string().min(1),
  });

  return {
    name: 'screen_abandon_impact',
    description:
      'Compara a taxa de compra de quem passou por uma tela específica com a de quem não passou. ' +
      'Use para "usuários que abandonam a tela X compram menos?". Informe o nome da tela em "tela". ' +
      'SEMPRE repita a ressalva de que correlação não prova causa.',
    inputSchema: {
      from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema, tela: z.string(),
    },
    outputSchema: {
      tela: z.string(), from: z.string(), to: z.string(),
      viramATela: z.object({ usuarios: z.number(), compradores: z.number(), taxaDeCompra: z.number() }),
      naoViramATela: z.object({ usuarios: z.number(), compradores: z.number(), taxaDeCompra: z.number() }),
      diferenca: z.number(),
      ressalva: z.string(),
    },
    handler: async (args) => {
      const { from, to, tenant, tela } = InputSchema.parse(args);

      const dataset = tenant.externalIds.ga4BigQueryDataset;
      if (!dataset) {
        throw new Error(`ga4BigQueryDataset não configurado para a organização "${tenant.organizationId}"`);
      }

      const rows = await client.query<ScreenImpactRow>(
        buildScreenImpactSql({ dataset }),
        { screenName: tela, fromCompact: toCompactDate(from), toCompact: toCompactDate(to) },
      );

      const cohort = (sawScreen: boolean) => {
        const row = rows.find((item) => item.saw_screen === sawScreen);
        const usuarios = Number(row?.users ?? 0);
        const compradores = Number(row?.buyers ?? 0);
        return {
          usuarios, compradores,
          taxaDeCompra: usuarios === 0 ? 0 : compradores / usuarios,
        };
      };

      const saw = cohort(true);
      const didNotSee = cohort(false);

      return {
        tela, from, to,
        viramATela: saw,
        naoViramATela: didNotSee,
        // Diferença em pontos percentuais, no sentido "quem viu menos quem não viu".
        diferenca: saw.taxaDeCompra - didNotSee.taxaDeCompra,
        ressalva: CAVEAT,
      };
    },
  };
}
