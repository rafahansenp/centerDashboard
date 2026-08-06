import { BetaAnalyticsDataClient } from '@google-analytics/data';
import type { Ga4ClientLike } from './interface.js';

export interface Ga4ReportParams {
  propertyId: string;
  metricNames: string[];
  from: string;
  to: string;
  dimensionNames: string[];
  dimensionFilters: Record<string, string>;
  limit?: number;
}

/** Linha achatada: dimensões e métricas por nome, já convertidas. */
export interface Ga4Row {
  dimensions: Record<string, string>;
  metrics: Record<string, number>;
}

export class Ga4Client implements Ga4ClientLike {
  constructor(private readonly api: BetaAnalyticsDataClient) {}

  static fromCredentialsJson(credentialsJson: string): Ga4Client {
    const credentials = JSON.parse(credentialsJson) as { client_email: string; private_key: string };
    return new Ga4Client(new BetaAnalyticsDataClient({ credentials }));
  }

  async runReport(params: Ga4ReportParams): Promise<Ga4Row[]> {
    const filterEntries = Object.entries(params.dimensionFilters);

    const [response] = await this.api.runReport({
      property: `properties/${params.propertyId}`,
      dateRanges: [{ startDate: params.from, endDate: params.to }],
      dimensions: params.dimensionNames.map((name) => ({ name })),
      metrics: params.metricNames.map((name) => ({ name })),
      limit: params.limit ?? 100_000,
      ...(filterEntries.length > 0
        ? {
            dimensionFilter: {
              andGroup: {
                expressions: filterEntries.map(([name, value]) => ({
                  filter: { fieldName: name, stringFilter: { matchType: 'EXACT' as const, value } },
                })),
              },
            },
          }
        : {}),
    });

    return (response.rows ?? []).map((row): Ga4Row => {
      const dimensions: Record<string, string> = {};
      params.dimensionNames.forEach((name, index) => {
        dimensions[name] = row.dimensionValues?.[index]?.value ?? '';
      });

      const metrics: Record<string, number> = {};
      params.metricNames.forEach((name, index) => {
        metrics[name] = Number(row.metricValues?.[index]?.value ?? 0);
      });

      return { dimensions, metrics };
    });
  }
}

/** `20260201` (formato do GA4) → `2026-02-01`. */
export function fromGa4Date(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}
