import { z } from 'zod';
import { IsoDateSchema, MetricUnitSchema } from './metrics.js';
import { TenantContextSchema } from './tenant.js';

export const RankingQuerySchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  tenant: TenantContextSchema,
  limit: z.number().int().min(1).max(50).default(10),
  orderBy: z.enum(['revenue', 'quantity', 'orders', 'users', 'sessions']).default('revenue'),
  filters: z.record(z.string(), z.string()).optional(),
});
export type RankingQuery = z.infer<typeof RankingQuerySchema>;

export const RankingRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  unit: MetricUnitSchema,
  /** Métricas secundárias da linha, ex.: { orders: 12, quantity: 30 }. */
  extra: z.record(z.string(), z.number()).default({}),
  /** Participação no total, de 0 a 1. */
  share: z.number().min(0).max(1),
});
export type RankingRow = z.infer<typeof RankingRowSchema>;

export const RankingResultSchema = z.object({
  dimension: z.string(),
  from: IsoDateSchema,
  to: IsoDateSchema,
  total: z.number(),
  unit: MetricUnitSchema,
  rows: z.array(RankingRowSchema),
});
export type RankingResult = z.infer<typeof RankingResultSchema>;

export const FunnelStepSchema = z.object({
  key: z.string(),
  label: z.string(),
  users: z.number(),
  /** Conversão em relação ao passo anterior, de 0 a 1. `null` no primeiro passo. */
  stepConversion: z.number().nullable(),
  /** Abandono absoluto entre o passo anterior e este. */
  dropOff: z.number(),
});
export type FunnelStep = z.infer<typeof FunnelStepSchema>;

export const FunnelResultSchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  steps: z.array(FunnelStepSchema),
  /** Chave do passo com maior abandono absoluto. */
  worstStepKey: z.string().nullable(),
  overallConversion: z.number(),
});
export type FunnelResult = z.infer<typeof FunnelResultSchema>;

export const ComparisonRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  valueA: z.number(),
  valueB: z.number(),
  delta: z.number(),
  /** `null` quando `valueA` é zero — variação percentual seria divisão por zero. */
  deltaRatio: z.number().nullable(),
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;

export const ComparisonResultSchema = z.object({
  dimension: z.string(),
  periodA: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
  periodB: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
  unit: MetricUnitSchema,
  rows: z.array(ComparisonRowSchema),
});
export type ComparisonResult = z.infer<typeof ComparisonResultSchema>;
