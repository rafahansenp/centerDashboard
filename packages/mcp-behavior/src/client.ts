import { BigQuery } from '@google-cloud/bigquery';
import type { BigQueryEventsClientLike } from './interface.js';

/**
 * O nome do dataset entra na SQL por interpolação — o BigQuery não aceita
 * parâmetro em nome de tabela. Por isso ele é validado contra uma allowlist de
 * caracteres: sem isso, um dataset malicioso vindo do banco viraria injeção.
 */
const DATASET_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/;

export function assertDatasetName(name: string): string {
  if (!DATASET_PATTERN.test(name)) {
    throw new Error(`dataset inválido: "${name}" (esperado [projeto.]dataset alfanumérico)`);
  }
  return name;
}

export class BigQueryEventsClient implements BigQueryEventsClientLike {
  constructor(private readonly bigquery: BigQuery) {}

  static fromCredentialsJson(credentialsJson: string): BigQueryEventsClient {
    const credentials = JSON.parse(credentialsJson) as {
      project_id: string; client_email: string; private_key: string;
    };
    return new BigQueryEventsClient(new BigQuery({
      projectId: credentials.project_id,
      credentials,
    }));
  }

  async query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
    const [rows] = await this.bigquery.query({
      query: sql,
      params,
      // Teto de custo por consulta: o export do GA4 cresce rápido e uma query
      // sem filtro de partição pode varrer terabytes.
      maximumBytesBilled: String(20 * 1024 ** 3),
      useLegacySql: false,
    });
    return rows as T[];
  }
}

/** `2026-02-01` → `20260201`, o sufixo das tabelas `events_*` do GA4. */
export function toCompactDate(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}
