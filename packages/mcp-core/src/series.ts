import {
  bucketStart, eachBucket,
  type MetricQuery, type MetricSeries, type MetricSource, type MetricUnit,
} from '@center/shared';

/** Linha crua de qualquer fonte: uma data diária, um valor, um grupo opcional. */
export interface SeriesRow {
  date: string;
  value: number;
  group: string | null;
}

/**
 * Converte linhas diárias na série canônica: agrupa por bucket, preenche
 * buckets vazios com zero (senão o gráfico ganha buracos e o total mente) e
 * ordena de forma determinística por (data, grupo).
 */
export function toSeries(
  rows: readonly SeriesRow[],
  query: MetricQuery,
  unit: MetricUnit,
  source: MetricSource,
): MetricSeries {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const key = `${bucketStart(row.date, query.granularity)} ${row.group ?? ''}`;
    totals.set(key, (totals.get(key) ?? 0) + row.value);
  }

  const groups = query.groupBy
    ? [...new Set(rows.map((row) => row.group ?? ''))].sort()
    : [''];

  const points = eachBucket(query.from, query.to, query.granularity).flatMap((bucket) =>
    groups.map((group) => {
      const value = totals.get(`${bucket} ${group}`) ?? 0;
      return group ? { date: bucket, value, group } : { date: bucket, value };
    }),
  );

  return {
    metricId: query.metricId,
    source,
    unit,
    granularity: query.granularity,
    total: points.reduce((acc, point) => acc + point.value, 0),
    points,
  };
}
