import type { MetricSource } from '@center/shared';

/** Módulos contratáveis, na ordem do catálogo (também a ordem do menu). */
export const MODULE_KEYS = [
  'overview',
  'products',
  'acquisition',
  'app_usage',
  'quality',
  'sprint',
  'assistant',
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export const INTEGRATION_KINDS = [
  'COMMERCE',
  'WEB_ANALYTICS',
  'APP_ANALYTICS',
  'PLAY_STORE',
  'APP_STORE',
  'SPRINT_BOARD',
] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export interface ModuleDefinition {
  key: ModuleKey;
  label: string;
  menuPath: string | null;
  /** Fontes de métricas que o módulo libera. */
  sources: readonly MetricSource[];
  /** Fontes que precisam estar prontas para o módulo ficar 'ready'. */
  requires: readonly MetricSource[];
}

export const MODULES: readonly ModuleDefinition[] = [
  { key: 'overview', label: 'Visão geral', menuPath: '/', sources: ['commerce'], requires: ['commerce'] },
  { key: 'products', label: 'Produtos', menuPath: '/produtos', sources: ['commerce'], requires: ['commerce'] },
  {
    key: 'acquisition',
    label: 'Aquisição',
    menuPath: '/aquisicao',
    sources: ['ga4', 'behavior', 'commerce'],
    requires: ['ga4', 'commerce'],
  },
  { key: 'app_usage', label: 'Uso do app', menuPath: '/uso-do-app', sources: ['firebase'], requires: ['firebase'] },
  { key: 'quality', label: 'Qualidade', menuPath: '/qualidade', sources: ['quality'], requires: ['quality'] },
  { key: 'sprint', label: 'Sprint', menuPath: '/sprint', sources: ['sprint'], requires: ['sprint'] },
  { key: 'assistant', label: 'Assistente de IA', menuPath: null, sources: [], requires: [] },
];

export function getModule(key: ModuleKey): ModuleDefinition {
  return MODULES.find((m) => m.key === key)!;
}

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

/** Integrações que alimentam cada fonte de métricas. */
export const SOURCE_INTEGRATIONS: Record<MetricSource, readonly IntegrationKind[]> = {
  commerce: ['COMMERCE'],
  ga4: ['WEB_ANALYTICS'],
  behavior: ['WEB_ANALYTICS'],
  firebase: ['APP_ANALYTICS'],
  quality: ['PLAY_STORE', 'APP_STORE'],
  sprint: ['SPRINT_BOARD'],
};
