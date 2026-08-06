import type { MetricDescriptor, MetricQuery, MetricSeries, MetricUnit } from '@center/shared';
import { MetricNotFoundError, toSeries, type MetricProvider, type SeriesRow } from '@center/mcp-core';
import { fromGa4Date } from './client.js';
import type { Ga4ClientLike } from './interface.js';
import { GA4_DIMENSION_NAMES, assertGa4Dimension } from './dimensions.js';

const DESCRIPTORS: MetricDescriptor[] = [
  { id: 'ga4.sessions', label: 'Sessões', description: 'Sessões no site e no app.',
    source: 'ga4', unit: 'count', dimensions: GA4_DIMENSION_NAMES },
  { id: 'ga4.active_users', label: 'Usuários ativos', description: 'Usuários distintos ativos no período. Filtre por platform para separar app de site.',
    source: 'ga4', unit: 'count', dimensions: GA4_DIMENSION_NAMES },
  { id: 'ga4.new_users', label: 'Novos usuários', description: 'Usuários que interagiram pela primeira vez.',
    source: 'ga4', unit: 'count', dimensions: GA4_DIMENSION_NAMES },
  { id: 'ga4.event_count', label: 'Eventos', description: 'Contagem total de eventos. Filtre por eventName para um evento específico.',
    source: 'ga4', unit: 'count', dimensions: GA4_DIMENSION_NAMES },
  { id: 'ga4.conversions', label: 'Conversões', description: 'Eventos marcados como conversão no GA4.',
    source: 'ga4', unit: 'count', dimensions: GA4_DIMENSION_NAMES },
  { id: 'ga4.purchase_revenue', label: 'Receita (GA4)', description: 'Receita medida pelo GA4, em centavos. Pode divergir do faturamento da Uappi — a fonte de verdade de faturamento é commerce.revenue.',
    source: 'ga4', unit: 'currency', dimensions: GA4_DIMENSION_NAMES },
];

const GA4_METRIC_NAME: Record<string, string> = {
  'ga4.sessions': 'sessions',
  'ga4.active_users': 'activeUsers',
  'ga4.new_users': 'newUsers',
  'ga4.event_count': 'eventCount',
  'ga4.conversions': 'conversions',
  'ga4.purchase_revenue': 'purchaseRevenue',
};

const UNITS: Record<string, MetricUnit> = {
  'ga4.purchase_revenue': 'currency',
};

export function createGa4Provider(client: Ga4ClientLike): MetricProvider {
  return {
    descriptors: DESCRIPTORS,

    async query(query: MetricQuery): Promise<MetricSeries> {
      const propertyId = query.tenant.externalIds.ga4PropertyId;
      if (!propertyId) {
        throw new Error(`ga4PropertyId não configurado para a organização "${query.tenant.organizationId}"`);
      }

      const metricName = GA4_METRIC_NAME[query.metricId];
      if (!metricName) throw new MetricNotFoundError(query.metricId);

      const filters = query.filters ?? {};
      const dimensionFilters: Record<string, string> = {};
      for (const [name, value] of Object.entries(filters)) {
        dimensionFilters[assertGa4Dimension(name)] = value;
      }

      const groupDimension = query.groupBy ? assertGa4Dimension(query.groupBy) : null;
      const dimensionNames = groupDimension ? ['date', groupDimension] : ['date'];

      const rows = await client.runReport({
        propertyId,
        metricNames: [metricName],
        from: query.from,
        to: query.to,
        dimensionNames,
        dimensionFilters,
      });

      const unit = UNITS[query.metricId] ?? 'count';

      const seriesRows: SeriesRow[] = rows.map((row) => ({
        date: fromGa4Date(row.dimensions.date ?? ''),
        // Dinheiro vira centavos na borda, como no resto do sistema.
        value: unit === 'currency'
          ? Math.round((row.metrics[metricName] ?? 0) * 100)
          : (row.metrics[metricName] ?? 0),
        group: groupDimension ? (row.dimensions[groupDimension] ?? '') : null,
      }));

      return toSeries(seriesRows, query, unit, 'ga4');
    },
  };
}
