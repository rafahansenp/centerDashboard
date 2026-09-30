import { z } from 'zod';
import { TenantContextSchema } from './tenant.js';

export const MetricSourceSchema = z.enum(['commerce', 'ga4', 'behavior', 'firebase', 'quality', 'sprint']);
export type MetricSource = z.infer<typeof MetricSourceSchema>;

export const MetricUnitSchema = z.enum(['count', 'currency', 'ratio', 'duration']);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

export const GranularitySchema = z.enum(['day', 'week', 'month']);
export type Granularity = z.infer<typeof GranularitySchema>;

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'esperado YYYY-MM-DD');

/** `id` é sempre `<source>.<nome>` — é o que permite roteamento sem estado no pool. */
export const MetricDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  source: MetricSourceSchema,
  unit: MetricUnitSchema,
  dimensions: z.array(z.string()),
});
export type MetricDescriptor = z.infer<typeof MetricDescriptorSchema>;

export const MetricQuerySchema = z.object({
  metricId: z.string().min(1),
  from: IsoDateSchema,
  to: IsoDateSchema,
  granularity: GranularitySchema,
  tenant: TenantContextSchema,
  filters: z.record(z.string(), z.string()).optional(),
  groupBy: z.string().optional(),
});
export type MetricQuery = z.infer<typeof MetricQuerySchema>;

export const MetricPointSchema = z.object({
  date: IsoDateSchema,
  /** Contagens e razões em unidade natural; valores monetários em CENTAVOS. */
  value: z.number(),
  group: z.string().optional(),
});
export type MetricPoint = z.infer<typeof MetricPointSchema>;

export const MetricSeriesSchema = z.object({
  metricId: z.string(),
  source: MetricSourceSchema,
  unit: MetricUnitSchema,
  granularity: GranularitySchema,
  total: z.number(),
  points: z.array(MetricPointSchema),
});
export type MetricSeries = z.infer<typeof MetricSeriesSchema>;

export const MetricCatalogSchema = z.object({ metrics: z.array(MetricDescriptorSchema) });
export type MetricCatalog = z.infer<typeof MetricCatalogSchema>;
