import type { Ga4ClientLike, Ga4ReportParams, Ga4Row } from '@center/mcp-ga4';
import { APP_EVENT_NAMES, APP_VERSIONS } from './dimensions.js';

/** Categorias plausíveis por dimensão, no vocabulário do app mobile. */
export const FIXTURE_CATEGORIES: Record<string, readonly string[]> = {
  eventName: APP_EVENT_NAMES,
  appVersion: APP_VERSIONS,
  platform: ['Android', 'iOS'],
  country: ['Brazil'],
};
const GENERIC_FALLBACK = ['categoria-a', 'categoria-b', 'categoria-c'];

function stringHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function deterministicValue(seedInput: string, metricName: string): number {
  const fraction = (stringHash(seedInput) % 1000) / 1000; // 0 .. 0.999, estável para a mesma entrada
  // Contagens (activeUsers, eventCount, newUsers, sessions): 10 a 2000 — a
  // penúltima versão da planilha chega a 5000, então a faixa é mais larga que
  // a do GA4 web para deixar `compare_by_version` com deltas visíveis.
  return Math.round(10 + fraction * 1990);
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
 * 1x para a versão mais recente (`APP_VERSIONS[0]`, sempre a base) ou para
 * uma versão fora da lista (ex.: request sem filtro). Qualquer versão mais
 * antiga recebe um fator entre 0.5x e 2.0x, próprio da combinação
 * versão+evento — nunca o mesmo fator pra dois eventos diferentes.
 */
function versionFactor(version: string | undefined, seed: string): number {
  if (!version) return 1;
  const index = APP_VERSIONS.indexOf(version as (typeof APP_VERSIONS)[number]);
  if (index <= 0) return 1;
  const fraction = (stringHash(`${version}|${seed}`) % 1000) / 1000; // 0 .. 0.999
  return Number((0.5 + fraction * 1.5).toFixed(3));
}

/**
 * Fixture determinística para o Firebase/GA4 do app mobile — mesma forma do
 * `MockGa4Client` do site (T5A), com o vocabulário de evento/versão do app.
 * Cada (versão, evento) tem seu PRÓPRIO fator — não um número único pra toda
 * a tabela — para `compare_by_version` sair com uma mistura real de queda e
 * crescimento entre as linhas, qualquer que seja o par de versões escolhido.
 */
export class MockFirebaseClient implements Ga4ClientLike {
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
          metrics: this.metricsWithVersionBias(`${date}|${group ?? ''}`, params.metricNames, group),
        });
      }
    }
    return rows;
  }

  private categoryRows(params: Ga4ReportParams): Ga4Row[] {
    const dimensionName = params.dimensionNames[0];
    if (!dimensionName) return [];
    const appVersionFilter = params.dimensionFilters.appVersion;
    const categories = FIXTURE_CATEGORIES[dimensionName] ?? GENERIC_FALLBACK;

    return categories.map((category) => ({
      dimensions: { [dimensionName]: category },
      metrics: this.metricsWithVersionBias(category, params.metricNames, appVersionFilter),
    }));
  }

  /**
   * A versão mais recente (`APP_VERSIONS[0]`) é sempre o fator-base (1x). Toda
   * versão mais antiga recebe um fator PRÓPRIO por evento — entre 0.5x e
   * 2.0x, sorteado (de forma determinística) a partir de `versão|evento` —
   * então, comparando duas versões quaisquer, umas linhas sobem e outras
   * caem, nunca uma queda uniforme igual em toda a tabela.
   */
  private metricsWithVersionBias(
    seed: string, metricNames: string[], version: string | undefined,
  ): Record<string, number> {
    const base = metricsFor(seed, metricNames);
    const factor = versionFactor(version, seed);
    if (factor === 1) return base;
    return Object.fromEntries(
      Object.entries(base).map(([name, value]) => [name, Math.round(value * factor)]),
    );
  }
}
