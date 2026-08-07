import { useFilters } from '../hooks/use-filters.js';
import { useTool } from '../hooks/use-tool.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { RankingTable } from '../components/charts/RankingTable.js';
import { FunnelChart } from '../components/charts/FunnelChart.js';
import type { FunnelResult, RankingResult } from '../lib/api-client.js';

export function AcquisitionPage({ today }: { today: string }) {
  const { filters } = useFilters(today);
  const period = { from: filters.from, to: filters.to };
  const withLimit = { ...period, limit: 10 };

  const trafficSources = useTool<RankingResult>('ga4', 'traffic_sources', withLimit);
  const campaignUsers = useTool<RankingResult>('ga4', 'campaign_users', withLimit);
  const campaignRevenue = useTool<RankingResult>('commerce', 'campaign_revenue', withLimit);
  const channelTicket = useTool<RankingResult>('commerce', 'channel_average_ticket', withLimit);
  const deviceRevenue = useTool<RankingResult>('commerce', 'device_revenue', withLimit);
  const devicePerformance = useTool<RankingResult>('ga4', 'device_performance', withLimit);
  const pagePerformance = useTool<RankingResult>('ga4', 'page_performance', withLimit);
  const funnel = useTool<FunnelResult>('ga4', 'checkout_funnel', period);

  const asError = (value: unknown) => (value instanceof Error ? value : null);

  return (
    <div className="space-y-6">
      <PeriodPicker today={today} />

      <FunnelChart
        title="Funil de compra"
        result={funnel.data}
        isLoading={funnel.isLoading}
        error={asError(funnel.error)}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RankingTable title="Origens de tráfego" description="Usuários por origem/mídia."
          result={trafficSources.data} isLoading={trafficSources.isLoading} error={asError(trafficSources.error)} />
        <RankingTable title="Campanhas por usuários" description="Medido pelo Analytics."
          result={campaignUsers.data} isLoading={campaignUsers.isLoading} error={asError(campaignUsers.error)} />
        {/* Receita vem da Uappi, não do GA4: a fonte de verdade de faturamento
            é a loja, e misturar as duas geraria dois números para a mesma coisa. */}
        <RankingTable title="Campanhas por receita" description="Receita real dos pedidos atribuídos."
          result={campaignRevenue.data} isLoading={campaignRevenue.isLoading} error={asError(campaignRevenue.error)} />
        <RankingTable title="Ticket médio por canal" description="Canal de venda registrado no pedido."
          result={channelTicket.data} isLoading={channelTicket.isLoading} error={asError(channelTicket.error)} />
        <RankingTable title="Receita por dispositivo" description="Dispositivo capturado no checkout."
          result={deviceRevenue.data} isLoading={deviceRevenue.isLoading} error={asError(deviceRevenue.error)} />
        <RankingTable title="Conversão por dispositivo" description="Conversões sobre sessões, no Analytics."
          result={devicePerformance.data} isLoading={devicePerformance.isLoading} error={asError(devicePerformance.error)} />
      </div>

      <RankingTable title="Páginas com maior abandono" description="Taxa de rejeição, da pior para a melhor."
        result={pagePerformance.data} isLoading={pagePerformance.isLoading} error={asError(pagePerformance.error)} />
    </div>
  );
}
