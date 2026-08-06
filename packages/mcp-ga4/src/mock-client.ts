import type { Ga4ClientLike } from './interface.js';
import type { Ga4ReportParams, Ga4Row } from './client.js';

/** Categorias plausíveis por dimensão. Dimensão fora daqui cai no fallback genérico. */
export const FIXTURE_CATEGORIES: Record<string, string[]> = {
  sessionSourceMedium: ['google / organic', 'facebook / cpc', 'direto / (none)'],
  sessionCampaignName: ['black-friday', 'natal', '(not set)'],
  deviceCategory: ['mobile', 'desktop', 'tablet'],
  pagePath: ['/', '/produto/camiseta', '/checkout'],
  appVersion: ['5.8.0', '5.7.2'],
  eventName: ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase'],
};
const GENERIC_FALLBACK = ['categoria-a', 'categoria-b', 'categoria-c'];

/** Métricas cujo valor plausível é uma taxa entre 0 e 1, não uma contagem. */
const RATIO_METRICS = new Set(['bounceRate', 'conversions']);

function stringHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function deterministicValue(seedInput: string, metricName: string): number {
  const fraction = (stringHash(seedInput) % 1000) / 1000; // 0 .. 0.999, estável para a mesma entrada
  if (metricName === 'bounceRate') return Number((0.1 + fraction * 0.6).toFixed(3));
  if (metricName === 'conversions' && RATIO_METRICS.has(metricName)) return Math.round(fraction * 50);
  if (metricName === 'purchaseRevenue') return Number((50 + fraction * 950).toFixed(2));
  // Contagens (sessions, activeUsers, newUsers, eventCount): 10 a 500.
  return Math.round(10 + fraction * 490);
}

function eachCompactDate(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10).replace(/-/g, ''));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function metricsFor(seed: string, metricNames: string[]): Record<string, number> {
  return Object.fromEntries(metricNames.map((name) => [name, deterministicValue(seed, name)]));
}

/**
 * Gera respostas plausíveis e determinísticas para qualquer combinação de
 * dimensões e métricas do GA4, sem tocar a rede. Ligado por
 * `MOCK_EXTERNAL_APIS=true` (T4). O funil gerado NÃO é garantidamente
 * monotônico — é ilustrativo, não uma simulação de comportamento real.
 */
export class MockGa4Client implements Ga4ClientLike {
  async runReport(params: Ga4ReportParams): Promise<Ga4Row[]> {
    if (params.dimensionNames.includes('date')) {
      return this.dateSeriesRows(params);
    }
    return this.categoryRows(params);
  }

  private dateSeriesRows(params: Ga4ReportParams): Ga4Row[] {
    const dates = eachCompactDate(params.from, params.to);
    const secondDimension = params.dimensionNames.find((name) => name !== 'date');
    const groups = secondDimension ? (FIXTURE_CATEGORIES[secondDimension] ?? GENERIC_FALLBACK) : [undefined];

    const rows: Ga4Row[] = [];
    for (const date of dates) {
      for (const group of groups) {
        const dimensions: Record<string, string> = { date };
        if (secondDimension && group) dimensions[secondDimension] = group;
        rows.push({
          dimensions,
          metrics: metricsFor(`${date}|${group ?? ''}`, params.metricNames),
        });
      }
    }
    return rows;
  }

  private categoryRows(params: Ga4ReportParams): Ga4Row[] {
    const dimensionName = params.dimensionNames[0];
    if (!dimensionName) return [];
    const categories = FIXTURE_CATEGORIES[dimensionName] ?? GENERIC_FALLBACK;

    return categories.map((category) => ({
      dimensions: { [dimensionName]: category },
      metrics: metricsFor(category, params.metricNames),
    }));
  }
}
