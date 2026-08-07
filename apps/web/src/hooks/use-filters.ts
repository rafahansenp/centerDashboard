import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Granularity, MetricSource } from '../lib/api-client.js';

export type PeriodPreset = 'today' | 'last7' | 'last30' | 'last90' | 'monthToDate' | 'lastMonth';

export interface DashboardFilters {
  from: string;
  to: string;
  granularity: Granularity;
  sources: MetricSource[];
}

/** `behavior` fica de fora do padrão: só existe depois da Fase 8. */
const DEFAULT_SOURCES: MetricSource[] = ['commerce', 'ga4'];
const ALL_SOURCES: MetricSource[] = ['commerce', 'ga4', 'behavior'];
const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

export function resolvePreset(
  preset: PeriodPreset,
  today: string,
): { from: string; to: string; granularity: Granularity } {
  const [year, month] = today.split('-').map(Number) as [number, number];

  switch (preset) {
    case 'today':
      return { from: today, to: today, granularity: 'day' };
    case 'last7':
      return { from: shiftDays(today, -6), to: today, granularity: 'day' };
    case 'last30':
      return { from: shiftDays(today, -29), to: today, granularity: 'day' };
    case 'last90':
      // 90 pontos diários deixam o eixo ilegível; semana é a leitura certa.
      return { from: shiftDays(today, -89), to: today, granularity: 'week' };
    case 'monthToDate':
      return { from: toIso(new Date(Date.UTC(year, month - 1, 1))), to: today, granularity: 'day' };
    case 'lastMonth': {
      const first = new Date(Date.UTC(year, month - 2, 1));
      // Dia 0 do mês seguinte = último dia do anterior. Cobre bissexto.
      const last = new Date(Date.UTC(year, month - 1, 0));
      return { from: toIso(first), to: toIso(last), granularity: 'day' };
    }
  }
}

export function useFilters(today: string = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })) {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<DashboardFilters>(() => {
    const fallback = resolvePreset('last30', today);

    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const granularity = searchParams.get('granularity') as Granularity | null;
    const sourcesParam = searchParams.get('sources');

    const parsedSources = sourcesParam
      ? sourcesParam.split(',').filter((s): s is MetricSource => ALL_SOURCES.includes(s as MetricSource))
      : DEFAULT_SOURCES;

    return {
      // Valor inválido na URL nunca quebra a tela — cai no default.
      from: from && ISO_DATE.test(from) ? from : fallback.from,
      to: to && ISO_DATE.test(to) ? to : fallback.to,
      granularity: granularity && GRANULARITIES.includes(granularity) ? granularity : fallback.granularity,
      sources: parsedSources.length > 0 ? parsedSources : DEFAULT_SOURCES,
    };
  }, [searchParams, today]);

  const setFilters = useCallback(
    (patch: Partial<DashboardFilters>) => {
      const next = { ...filters, ...patch };
      setSearchParams({
        from: next.from, to: next.to,
        granularity: next.granularity, sources: next.sources.join(','),
      }, { replace: true });
    },
    [filters, setSearchParams],
  );

  const applyPreset = useCallback(
    (preset: PeriodPreset) => setFilters(resolvePreset(preset, today)),
    [setFilters, today],
  );

  return { filters, setFilters, applyPreset };
}
