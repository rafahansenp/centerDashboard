import type { MetricSource } from '@center/shared';
import { MODULES, SOURCE_INTEGRATIONS, getModule, type IntegrationKind, type ModuleKey } from './catalog.js';

export interface ContractRow {
  moduleKey: string;
  status: 'ACTIVE' | 'SUSPENDED';
  startsAt: Date;
  endsAt: Date | null;
}

export interface IntegrationState {
  kind: IntegrationKind;
  status: 'PENDING' | 'OK' | 'ERROR' | 'DISABLED';
  hasBigQueryDataset: boolean;
}

export type SourceDecision = 'allowed' | 'forbidden' | 'pending';

/** Contrato vigente: ativo, já iniciado e não encerrado (endsAt é exclusivo). */
export function isContractInForce(contract: ContractRow, now: Date): boolean {
  if (contract.status !== 'ACTIVE') return false;
  if (contract.startsAt.getTime() > now.getTime()) return false;
  return contract.endsAt === null || contract.endsAt.getTime() > now.getTime();
}

/** Módulos visíveis, na ordem do catálogo. MEMBER só vê os que recebeu por grant. */
export function visibleModules(input: {
  organizationActive: boolean;
  role: 'ADMIN' | 'MEMBER';
  contracts: ContractRow[];
  grants: string[];
  now: Date;
}): ModuleKey[] {
  if (!input.organizationActive) return [];
  const inForce = new Set(
    input.contracts.filter((c) => isContractInForce(c, input.now)).map((c) => c.moduleKey),
  );
  const granted = new Set(input.grants);
  return MODULES.filter(
    (m) => inForce.has(m.key) && (input.role === 'ADMIN' || granted.has(m.key)),
  ).map((m) => m.key);
}

export function allowedSources(modules: readonly ModuleKey[]): Set<MetricSource> {
  const out = new Set<MetricSource>();
  for (const key of modules) for (const s of getModule(key).sources) out.add(s);
  return out;
}

/** Fonte pronta: alguma integração aceita está OK (behavior exige também dataset no BigQuery). */
export function isSourceReady(source: MetricSource, integrations: readonly IntegrationState[]): boolean {
  const kinds = SOURCE_INTEGRATIONS[source];
  return integrations.some(
    (i) =>
      kinds.includes(i.kind) && i.status === 'OK' && (source !== 'behavior' || i.hasBigQueryDataset),
  );
}

export function moduleReadiness(
  key: ModuleKey,
  integrations: readonly IntegrationState[],
): 'ready' | 'awaiting_setup' {
  return getModule(key).requires.every((s) => isSourceReady(s, integrations)) ? 'ready' : 'awaiting_setup';
}

export function decideSource(
  source: MetricSource,
  modules: readonly ModuleKey[],
  integrations: readonly IntegrationState[],
): SourceDecision {
  if (!allowedSources(modules).has(source)) return 'forbidden';
  return isSourceReady(source, integrations) ? 'allowed' : 'pending';
}
