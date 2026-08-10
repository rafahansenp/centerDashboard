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
        -- ANY_VALUE (não uma subquery escalar simples) porque um único evento
        -- pode carregar mais de uma das três chaves ao mesmo tempo (ex.: SDK
        -- do Firebase gravando firebase_screen e um evento custom gravando
        -- page_title juntos) — sem o agregador, "mais de um elemento" derruba
        -- a query inteira em produção.
        (SELECT ANY_VALUE(value.string_value) FROM UNNEST(event_params)
         WHERE key IN ('firebase_screen', 'screen_name', 'page_title')) AS screen
      FROM \`${dataset}.events_*\`
      WHERE _TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact
    ),
    per_user AS (
      SELECT
        user_pseudo_id,
        -- COALESCE(..., FALSE): LOGICAL_OR devolve NULL (não FALSE) quando
        -- "screen" é NULL em todos os eventos do usuário — sem isso, quem
        -- nunca dispara firebase_screen/screen_name/page_title cai num
        -- terceiro grupo saw_screen=NULL que nem viramATela nem
        -- naoViramATela capturam, e o usuário some da comparação inteira.
        COALESCE(LOGICAL_OR(screen = @screenName), FALSE) AS saw_screen,
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
      'Use para "usuários que abandonam a tela X compram menos?". Informe o nome da tela em "tela" — ' +
      'a comparação com o GA4/Firebase é sensível a maiúsculas/minúsculas. taxaDeCompra vai de 0 a 1 ' +
      '(0,05 = 5%). diferenca é viramATela.taxaDeCompra menos naoViramATela.taxaDeCompra, em pontos ' +
      'percentuais (negativo = quem viu a tela compra menos). diferenca vem null quando um dos dois ' +
      'grupos não tem nenhum usuário no período — nesse caso NÃO existe comparação válida; leia ' +
      '"observacao" e diga isso ao usuário em vez de citar um número. ' +
      'SEMPRE repita a ressalva de que correlação não prova causa.',
    inputSchema: {
      from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema, tela: z.string(),
    },
    outputSchema: {
      tela: z.string(), from: z.string(), to: z.string(),
      viramATela: z.object({
        usuarios: z.number(), compradores: z.number(),
        taxaDeCompra: z.number().describe('fração de 0 a 1; 0,05 significa que 5% desse grupo comprou'),
      }),
      naoViramATela: z.object({
        usuarios: z.number(), compradores: z.number(),
        taxaDeCompra: z.number().describe('fração de 0 a 1; 0,05 significa que 5% desse grupo comprou'),
      }),
      diferenca: z.number().nullable().describe(
        'viramATela.taxaDeCompra menos naoViramATela.taxaDeCompra, em pontos percentuais ' +
        '(ex.: -0,15 = 15 pontos percentuais a menos). null quando um dos grupos não tem usuários — ' +
        'ver "observacao" em vez de calcular ou estimar a diferença.',
      ),
      observacao: z.string(),
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

      // Um dos dois grupos vazio não é "diferença zero" — é ausência de
      // comparação. Acontece com um nome de tela que não bate com o que o
      // GA4/Firebase registra (maiúsculas/minúsculas, tela não instrumentada)
      // ou, no extremo oposto, com uma tela que todo mundo visita. Nos dois
      // casos, devolver um número aqui seria inventar um achado causal a
      // partir de um erro de digitação — por isso `diferenca` vira `null` e a
      // razão vai em `observacao`, em vez de silenciosamente reportar 0 ou
      // uma diferença fabricada.
      const observacao = saw.usuarios === 0
        ? `Nenhum usuário do período foi identificado na tela "${tela}" — confira se o nome bate ` +
          'exatamente com o que o GA4/Firebase registra (maiúsculas/minúsculas importam) ou se essa ' +
          'tela não é instrumentada nesse app/site. Sem usuários nesse grupo, a diferença não pode ' +
          'ser calculada.'
        : didNotSee.usuarios === 0
          ? `Todos os usuários do período passaram pela tela "${tela}" — não existe grupo de ` +
            'comparação nesse período, então a diferença não pode ser calculada.'
          : '';

      return {
        tela, from, to,
        viramATela: saw,
        naoViramATela: didNotSee,
        // Diferença em pontos percentuais, no sentido "quem viu menos quem não viu".
        diferenca: observacao ? null : saw.taxaDeCompra - didNotSee.taxaDeCompra,
        observacao,
        ressalva: CAVEAT,
      };
    },
  };
}
