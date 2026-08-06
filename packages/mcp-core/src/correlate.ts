import type {
  Granularity, MetricQuery, MetricUnit, TenantContext,
} from '@center/shared';
import type { MetricGateway } from './gateway.js';

export type CorrelationStrength = 'forte' | 'moderada' | 'fraca' | 'desprezivel' | 'indeterminada';
export type CorrelationDirection = 'positiva' | 'negativa' | 'indefinida';

/** Menos de 3 pontos não sustenta nenhuma afirmação sobre relação entre séries. */
const MIN_POINTS = 3;

const CAVEAT =
  'Correlação não implica causa. Este número mede se as duas séries se moveram juntas ' +
  'no período — não prova que uma causou a outra, e um fator externo pode explicar as duas.';

/**
 * Coeficiente de Pearson. Devolve `null` — não zero — quando o cálculo não é
 * definido: séries curtas demais, tamanhos diferentes ou variância zero.
 * Zero significaria "não há relação", o que é uma afirmação; `null` significa
 * "não dá para dizer", que é a verdade nesses casos.
 */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < MIN_POINTS) return null;

  const n = a.length;
  const meanA = a.reduce((acc, value) => acc + value, 0) / n;
  const meanB = b.reduce((acc, value) => acc + value, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;

  for (let index = 0; index < n; index += 1) {
    const deltaA = (a[index] ?? 0) - meanA;
    const deltaB = (b[index] ?? 0) - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA * deltaA;
    varianceB += deltaB * deltaB;
  }

  const denominator = Math.sqrt(varianceA * varianceB);
  if (denominator === 0) return null;

  return covariance / denominator;
}

export function describeStrength(coefficient: number | null): CorrelationStrength {
  if (coefficient === null || Number.isNaN(coefficient)) return 'indeterminada';
  const magnitude = Math.abs(coefficient);
  if (magnitude >= 0.7) return 'forte';
  if (magnitude >= 0.4) return 'moderada';
  if (magnitude >= 0.2) return 'fraca';
  return 'desprezivel';
}

export interface CorrelateInput {
  metricIdA: string;
  metricIdB: string;
  from: string;
  to: string;
  granularity: Granularity;
  tenant: TenantContext;
}

export interface CorrelationResult {
  metricA: { id: string; unit: MetricUnit; total: number };
  metricB: { id: string; unit: MetricUnit; total: number };
  from: string;
  to: string;
  granularity: Granularity;
  buckets: number;
  coefficient: number | null;
  strength: CorrelationStrength;
  direction: CorrelationDirection;
  series: Array<{ date: string; valueA: number; valueB: number }>;
  caveat: string;
}

/**
 * Correlaciona duas métricas quaisquer no tempo.
 *
 * Vive no gateway, não num MCP server, porque precisa enxergar todas as fontes —
 * é o que permite cruzar `ga4.active_users` com `commerce.revenue` sem que
 * nenhum servidor conheça o outro.
 */
export async function correlateMetrics(
  gateway: MetricGateway,
  input: CorrelateInput,
): Promise<CorrelationResult> {
  if (input.metricIdA === input.metricIdB) {
    throw new Error('não faz sentido correlacionar uma métrica com ela mesma');
  }

  const base = {
    from: input.from, to: input.to,
    granularity: input.granularity, tenant: input.tenant,
  };
  const queries: MetricQuery[] = [
    { ...base, metricId: input.metricIdA },
    { ...base, metricId: input.metricIdB },
  ];

  const [seriesA, seriesB] = await gateway.queryBatch(queries);
  if (!seriesA || !seriesB) throw new Error('não foi possível obter as duas séries');

  // Alinhamento por data: séries de fontes diferentes podem ter buckets
  // distintos, e parear por índice cruzaria dias errados silenciosamente.
  const mapB = new Map(seriesB.points.map((point) => [point.date, point.value]));
  const aligned = seriesA.points
    .filter((point) => mapB.has(point.date))
    .map((point) => ({ date: point.date, valueA: point.value, valueB: mapB.get(point.date)! }));

  const coefficient = pearson(
    aligned.map((row) => row.valueA),
    aligned.map((row) => row.valueB),
  );

  return {
    metricA: { id: seriesA.metricId, unit: seriesA.unit, total: seriesA.total },
    metricB: { id: seriesB.metricId, unit: seriesB.unit, total: seriesB.total },
    from: input.from, to: input.to, granularity: input.granularity,
    buckets: aligned.length,
    coefficient,
    strength: describeStrength(coefficient),
    direction: coefficient === null ? 'indefinida' : coefficient >= 0 ? 'positiva' : 'negativa',
    series: aligned,
    caveat: CAVEAT,
  };
}
