import type { Granularity, MetricUnit } from './api-client.js';

const LOCALE = 'pt-BR';

const currency = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'BRL' });
const count = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const ratio = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 1 });

/**
 * O ÚNICO lugar que divide por 100. Dinheiro circula como inteiro de centavos
 * em todo o resto do sistema — se outra função dividir, os dois números vão
 * divergir e ninguém vai saber qual está certo.
 */
export function formatMetricValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'currency': return currency.format(value / 100);
    case 'ratio': return ratio.format(value);
    case 'duration': {
      const minutes = Math.floor(value / 60);
      const seconds = Math.round(value % 60);
      return minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`;
    }
    default: return count.format(value);
  }
}

const MONTH_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Rótulo curto de eixo. Deliberadamente compacto: eixos não comportam datas longas. */
export function formatBucketLabel(isoDate: string, granularity: Granularity): string {
  const [year, month, day] = isoDate.split('-') as [string, string, string];
  if (granularity === 'month') return `${MONTH_ABBR[Number(month) - 1]}/${year.slice(2)}`;
  const short = `${day}/${month}`;
  return granularity === 'week' ? `sem. ${short}` : short;
}
