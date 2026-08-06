import { Prisma } from '@prisma/client';

/**
 * O QUE CONTA COMO VENDA. Uma constante só, usada por toda consulta de receita.
 *
 * Cancelado, falho e aguardando pagamento NÃO são receita. Se cada query
 * decidisse isso por conta própria, o faturamento da dashboard e o do bot
 * divergiriam e ninguém saberia qual está certo.
 */
export const REVENUE_STATUS_GROUPS = [
  'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED',
] as const;

export const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

/** Colunas do pedido que podem ser filtradas ou agrupadas. */
export const ORDER_DIMENSIONS: Record<string, string> = {
  channel: 'canal',
  paymentMethod: 'paymentMethod',
  campaign: 'attributionCampaign',
  source: 'attributionSource',
  device: 'attributionDevice',
  status: 'statusGroup',
};

export const ORDER_DIMENSION_NAMES = Object.keys(ORDER_DIMENSIONS);

/**
 * Trunca no fuso de negócio. Sem o `AT TIME ZONE`, um pedido das 23h30 de São
 * Paulo cairia no dia seguinte e "quanto vendemos hoje" mentiria toda noite.
 *
 * `emittedAt` é `timestamp without time zone` (naive) guardando o instante em
 * UTC. Um único `AT TIME ZONE 'America/Sao_Paulo'` sobre um naive faz Postgres
 * interpretar o valor como se já estivesse em São Paulo e convertê-lo PARA
 * UTC — o inverso do que queremos, e desloca o bucket em 3h. O idioma correto
 * é marcar o naive como UTC primeiro e só então converter para o fuso local.
 */
export function bucketExpression(granularity: 'day' | 'week' | 'month'): Prisma.Sql {
  const unit = granularity === 'day' ? 'day' : granularity === 'week' ? 'week' : 'month';
  return Prisma.sql`to_char(date_trunc(${unit}, o."emittedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${BUSINESS_TIME_ZONE}), 'YYYY-MM-DD')`;
}

/** Converte o range de datas de negócio nos instantes UTC correspondentes. */
export function rangeToUtc(from: string, to: string): { start: Date; end: Date } {
  return {
    start: new Date(`${from}T00:00:00-03:00`),
    // Fim exclusivo no dia seguinte: cobre 23:59:59.999 sem depender de precisão.
    end: new Date(new Date(`${to}T00:00:00-03:00`).getTime() + 24 * 60 * 60 * 1000),
  };
}

export function assertDimension(name: string): string {
  const column = ORDER_DIMENSIONS[name];
  if (!column) {
    throw new Error(
      `dimensão não suportada: "${name}". Disponíveis: ${ORDER_DIMENSION_NAMES.join(', ')}`,
    );
  }
  return column;
}
