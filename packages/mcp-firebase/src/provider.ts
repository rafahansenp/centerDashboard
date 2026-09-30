import type { MetricDescriptor, MetricQuery, MetricSeries, MetricUnit } from '@center/shared';
import { MetricNotFoundError, toSeries, type MetricProvider, type SeriesRow } from '@center/mcp-core';
import { fromGa4Date, type Ga4ClientLike } from '@center/mcp-ga4';
import { FIREBASE_DIMENSION_NAMES, assertFirebaseDimension } from './dimensions.js';

const DESCRIPTORS: MetricDescriptor[] = [
  { id: 'firebase.active_users', label: 'Usuários ativos (app)', description: 'Usuários distintos ativos no app no período. Filtre por appVersion para comparar versões.',
    source: 'firebase', unit: 'count', dimensions: FIREBASE_DIMENSION_NAMES },
  { id: 'firebase.event_count', label: 'Eventos (app)', description: 'Contagem total de eventos do app. Filtre por eventName para um evento específico (ex.: cadastro_usuario).',
    source: 'firebase', unit: 'count', dimensions: FIREBASE_DIMENSION_NAMES },
  { id: 'firebase.new_users', label: 'Novos usuários (app)', description: 'Usuários que interagiram com o app pela primeira vez no período.',
    source: 'firebase', unit: 'count', dimensions: FIREBASE_DIMENSION_NAMES },
];

const FIREBASE_METRIC_NAME: Record<string, string> = {
  'firebase.active_users': 'activeUsers',
  'firebase.event_count': 'eventCount',
  'firebase.new_users': 'newUsers',
};

export function createFirebaseProvider(client: Ga4ClientLike): MetricProvider {
  return {
    descriptors: DESCRIPTORS,

    async query(query: MetricQuery): Promise<MetricSeries> {
      const propertyId = query.tenant.externalIds.ga4AppPropertyId;
      if (!propertyId) {
        throw new Error(`ga4AppPropertyId não configurado para a organização "${query.tenant.organizationId}"`);
      }

      const metricName = FIREBASE_METRIC_NAME[query.metricId];
      if (!metricName) throw new MetricNotFoundError(query.metricId);

      const filters = query.filters ?? {};
      const dimensionFilters: Record<string, string> = {};
      for (const [name, value] of Object.entries(filters)) {
        dimensionFilters[assertFirebaseDimension(name)] = value;
      }

      const groupDimension = query.groupBy ? assertFirebaseDimension(query.groupBy) : null;
      const dimensionNames = groupDimension ? ['date', groupDimension] : ['date'];

      const rows = await client.runReport({
        propertyId,
        metricNames: [metricName],
        from: query.from,
        to: query.to,
        dimensionNames,
        dimensionFilters,
      });

      const unit: MetricUnit = 'count';

      const seriesRows: SeriesRow[] = rows.map((row) => ({
        date: fromGa4Date(row.dimensions.date ?? ''),
        value: row.metrics[metricName] ?? 0,
        group: groupDimension ? (row.dimensions[groupDimension] ?? '') : null,
      }));

      return toSeries(seriesRows, query, unit, 'firebase');
    },
  };
}
