import type { MetricQuery, TenantContext } from '@center/shared';
import type { MetricGateway } from '@center/mcp-core';

/** Abaixo de 5% de variação não afirmamos que houve mudança. */
export const RELEVANCE_THRESHOLD = 0.05;
const DEFAULT_WINDOW_DAYS = 14;

const CAVEAT =
  'Outros fatores podem explicar a diferença — sazonalidade, campanhas ativas, promoções ' +
  'ou mudanças de preço no mesmo período. Esta comparação mostra o que aconteceu antes e ' +
  'depois do lançamento, não prova que a atualização foi a causa.';

export type ImpactVerdict = 'melhorou' | 'piorou' | 'sem-mudanca-relevante' | 'inconclusivo';

export interface VersionImpactInput {
  gateway: MetricGateway;
  tenant: TenantContext;
  version: string;
  releaseDate: string;
  windowDays?: number;
  today: string;
}

export interface VersionImpactResult {
  version: string;
  releaseDate: string;
  windowDays: number;
  before: { from: string; to: string; revenueCents: number; orders: number; users: number };
  after: { from: string; to: string; revenueCents: number; orders: number; users: number };
  revenueDelta: number;
  revenueDeltaRatio: number | null;
  ordersDelta: number;
  usersDelta: number;
  adoption: { users: number; share: number } | null;
  verdict: ImpactVerdict;
  caveat: string;
}

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

const METRIC_IDS = ['commerce.revenue', 'commerce.orders', 'ga4.active_users'] as const;

/**
 * Compara janelas simétricas antes e depois do lançamento de uma versão.
 *
 * Não é correlação: a pergunta é sobre um evento pontual, não sobre duas séries
 * se movendo juntas. Janelas simétricas evitam a comparação injusta de "duas
 * semanas antes contra três dias depois", que sempre favorece o "antes".
 */
export async function analyzeAppVersionImpact(
  input: VersionImpactInput,
): Promise<VersionImpactResult> {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;

  const elapsed = daysBetween(input.releaseDate, input.today);
  if (elapsed < 0) {
    throw new Error(`data de lançamento no futuro: ${input.releaseDate}`);
  }

  const before = { from: shiftDays(input.releaseDate, -windowDays), to: shiftDays(input.releaseDate, -1) };
  // A janela "depois" nunca ultrapassa hoje.
  const afterEnd = shiftDays(input.releaseDate, windowDays - 1);
  const after = { from: input.releaseDate, to: afterEnd <= input.today ? afterEnd : input.today };

  const buildQueries = (window: { from: string; to: string }): MetricQuery[] =>
    METRIC_IDS.map((metricId) => ({
      metricId, from: window.from, to: window.to,
      granularity: 'day' as const, tenant: input.tenant,
    }));

  const [beforeSeries, afterSeries] = await Promise.all([
    input.gateway.queryBatch(buildQueries(before)),
    input.gateway.queryBatch(buildQueries(after)),
  ]);

  const totalOf = (list: typeof beforeSeries, metricId: string): number =>
    list.find((item) => item.metricId === metricId)?.total ?? 0;

  const beforeTotals = {
    ...before,
    revenueCents: totalOf(beforeSeries, 'commerce.revenue'),
    orders: totalOf(beforeSeries, 'commerce.orders'),
    users: totalOf(beforeSeries, 'ga4.active_users'),
  };
  const afterTotals = {
    ...after,
    revenueCents: totalOf(afterSeries, 'commerce.revenue'),
    orders: totalOf(afterSeries, 'commerce.orders'),
    users: totalOf(afterSeries, 'ga4.active_users'),
  };

  const revenueDelta = afterTotals.revenueCents - beforeTotals.revenueCents;
  const revenueDeltaRatio = beforeTotals.revenueCents === 0
    ? null
    : revenueDelta / beforeTotals.revenueCents;

  // Adoção da versão: se quase ninguém atualizou, a comparação não diz nada
  // sobre a versão — diz sobre o período.
  let adoption: { users: number; share: number } | null = null;
  try {
    const ranking = await input.gateway.callTool<{
      rows: Array<{ key: string; value: number; share: number }>;
    }>('ga4', 'app_versions', { from: after.from, to: after.to, tenant: input.tenant, limit: 50 });
    const row = ranking.rows.find((item) => item.key === input.version);
    if (row) adoption = { users: row.value, share: row.share };
  } catch {
    // Adoção é informação de apoio; sua ausência não invalida a comparação.
  }

  const windowIncomplete = elapsed < windowDays;
  const verdict: ImpactVerdict =
    windowIncomplete || revenueDeltaRatio === null
      ? 'inconclusivo'
      : Math.abs(revenueDeltaRatio) < RELEVANCE_THRESHOLD
        ? 'sem-mudanca-relevante'
        : revenueDeltaRatio > 0 ? 'melhorou' : 'piorou';

  return {
    version: input.version,
    releaseDate: input.releaseDate,
    windowDays,
    before: beforeTotals,
    after: afterTotals,
    revenueDelta,
    revenueDeltaRatio,
    ordersDelta: afterTotals.orders - beforeTotals.orders,
    usersDelta: afterTotals.users - beforeTotals.users,
    adoption,
    verdict,
    caveat: CAVEAT,
  };
}
