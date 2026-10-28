import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import type { Ga4ClientLike } from '@center/mcp-ga4';

/**
 * Funil de eventos da loja dentro do app, na ordem em que a planilha original
 * (PAINEL MCP APP) listou os eventos — não reordenamos por não termos a
 * jornada real documentada. Se a ordem certa for outra, é ajustar esta lista.
 */
export const SHOP_FUNNEL_STEPS: Array<{ key: string; label: string }> = [
  { key: 'Loja_view_promotion', label: 'Viu promoção' },
  { key: 'Loja_shop_busca', label: 'Buscou na loja' },
  { key: 'Loja_select_item', label: 'Selecionou item' },
  { key: 'Loja_view_categories', label: 'Viu categorias' },
  { key: 'Loja_shop_view', label: 'Viu a loja' },
  { key: 'Loja_add_to_cart', label: 'Adicionou ao carrinho' },
  { key: 'Loja_search', label: 'Buscou' },
  { key: 'Loja_cart_view', label: 'Viu o carrinho' },
  { key: 'Loja_AddToCart_GoToCart', label: 'Foi ao carrinho após adicionar' },
  { key: 'Loja_select_promotion', label: 'Selecionou promoção' },
];

const NOTE =
  'O GA4/Firebase é agregado e não identifica pessoas: este funil informa QUANTOS ' +
  'usuários passaram por cada etapa da loja dentro do app, nunca quais usuários.';

export function createShopFunnelTool(client: Ga4ClientLike): AnalysisTool {
  const InputSchema = z.object({
    from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema,
  });

  return {
    name: 'shop_funnel',
    description:
      'Funil de eventos da loja dentro do app no período, com usuários por etapa e ' +
      'abandono entre etapas. Use para "onde os usuários abandonam a loja dentro do app". ' +
      'NÃO identifica usuários individualmente.',
    inputSchema: { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema },
    outputSchema: {
      from: z.string(), to: z.string(),
      steps: z.array(z.object({
        key: z.string(), label: z.string(), users: z.number(),
        stepConversion: z.number().nullable(), dropOff: z.number(),
      })),
      worstStepKey: z.string().nullable(),
      overallConversion: z.number(),
      identifiesUsers: z.boolean(),
      note: z.string(),
    },
    handler: async (args) => {
      const { from, to, tenant } = InputSchema.parse(args);
      const propertyId = tenant.externalIds.ga4AppPropertyId;
      if (!propertyId) {
        throw new Error(`ga4AppPropertyId não configurado para a organização "${tenant.organizationId}"`);
      }

      const rows = await client.runReport({
        propertyId,
        metricNames: ['activeUsers', 'eventCount'],
        from, to,
        dimensionNames: ['eventName'],
        dimensionFilters: {},
      });

      const usersByEvent = new Map(
        rows.map((row) => [row.dimensions.eventName ?? '', row.metrics.activeUsers ?? 0]),
      );

      let previousUsers: number | null = null;
      const steps = SHOP_FUNNEL_STEPS.map((step) => {
        const users = usersByEvent.get(step.key) ?? 0;
        const stepConversion = previousUsers === null
          ? null
          : previousUsers === 0 ? 0 : users / previousUsers;
        const dropOff = previousUsers === null ? 0 : Math.max(0, previousUsers - users);
        previousUsers = users;
        return { key: step.key, label: step.label, users, stepConversion, dropOff };
      });

      const firstUsers = steps[0]?.users ?? 0;
      const lastUsers = steps[steps.length - 1]?.users ?? 0;

      const worst = steps.reduce<{ key: string; dropOff: number } | null>(
        (best, step) => (best === null || step.dropOff > best.dropOff
          ? { key: step.key, dropOff: step.dropOff }
          : best),
        null,
      );

      return {
        from, to, steps,
        worstStepKey: worst && worst.dropOff > 0 ? worst.key : null,
        overallConversion: firstUsers === 0 ? 0 : lastUsers / firstUsers,
        identifiesUsers: false,
        note: NOTE,
      };
    },
  };
}
