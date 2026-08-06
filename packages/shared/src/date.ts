import type { Granularity } from './metrics.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(isoDate: string): Date {
  if (!ISO_DATE.test(isoDate)) {
    throw new Error(`data inválida: "${isoDate}" (esperado YYYY-MM-DD)`);
  }
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) throw new Error(`data inválida: "${isoDate}"`);
  return date;
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function bucketStart(isoDate: string, granularity: Granularity): string {
  const date = toUtc(isoDate);
  if (granularity === 'day') return toIso(date);
  if (granularity === 'month') {
    return toIso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
  }
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return toIso(date);
}

export function eachBucket(from: string, to: string, granularity: Granularity): string[] {
  const start = toUtc(bucketStart(from, granularity));
  const end = toUtc(bucketStart(to, granularity));
  if (start.getTime() > end.getTime()) {
    throw new Error(`range inválido: "${from}" é posterior a "${to}"`);
  }

  const buckets: string[] = [];
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    buckets.push(toIso(cursor));
    if (granularity === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (granularity === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return buckets;
}
