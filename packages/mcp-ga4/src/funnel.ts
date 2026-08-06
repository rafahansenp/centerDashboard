import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import type { Ga4ClientLike } from './interface.js';

/**
 * Eventos padrão de e-commerce do GA4, na ordem do funil. Se a loja não os
 * dispara, os passos vêm zerados — o que é informação, não erro.
 */
export const CHECKOUT_FUNNEL_STEPS: Array<{ key: string; label: string }> = [
  { key: 'view_item', label: 'Viu produto' },
  { key: 'add_to_cart', label: 'Adicionou ao carrinho' },
  { key: 'begin_checkout', label: 'Iniciou o checkout' },
  { key: 'add_payment_info', label: 'Informou pagamento' },
  { key: 'purchase', label: 'Comprou' },
];

const NOTE =
  'O GA4 é agregado e não identifica pessoas: este funil informa QUANTOS usuários ' +
  'abandonaram e EM QUAL etapa, nunca quais clientes. Para recuperar contatos de ' +
  'carrinho abandonado seria necessário um endpoint administrativo da loja.';

export function createCheckoutFunnelTool(client: Ga4ClientLike): AnalysisTool {
  const InputSchema = z.object({
    from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema,
  });

  return {
    name: 'checkout_funnel',
    description:
      'Funil de compra no período (viu produto → carrinho → checkout → pagamento → compra), ' +
      'com usuários por etapa, conversão entre etapas e abandono. Responde "qual etapa do ' +
      'checkout possui maior abandono", "qual funil converte menos" e quantos abandonaram ' +
      'o carrinho. NÃO identifica clientes individualmente.',
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
      const propertyId = tenant.externalIds.ga4PropertyId;
      if (!propertyId) {
        throw new Error(`ga4PropertyId não configurado para a organização "${tenant.organizationId}"`);
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
      const steps = CHECKOUT_FUNNEL_STEPS.map((step) => {
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

      // Maior perda ABSOLUTA — é onde consertar rende mais, e é o que a
      // pergunta "qual etapa abandona mais" realmente quer saber.
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
