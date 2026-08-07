import {
  Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
  type TooltipProps,
} from 'recharts';
import type { Granularity, MetricSeries, MetricUnit } from '../../lib/api-client.js';
import { formatBucketLabel, formatMetricValue } from '../../lib/format.js';
import { SERIES_COLOR_BY_SOURCE, SOURCE_LABEL } from '../../lib/viz-colors.js';
import { ChartFrame } from './ChartFrame.js';

interface TimeSeriesChartProps {
  title: string;
  description?: string;
  seriesList: MetricSeries[];
  granularity: Granularity;
  unit: MetricUnit;
  isLoading?: boolean;
  error?: Error | null;
}

interface ChartRow { bucket: string; [seriesName: string]: string | number }

/**
 * Uma única escala Y, sempre. Duas métricas de grandezas diferentes (reais e
 * contagem) NUNCA compartilham este componente — são dois gráficos lado a lado.
 */
function buildRows(seriesList: MetricSeries[], granularity: Granularity): ChartRow[] {
  const buckets = [...new Set(seriesList.flatMap((series) => series.points.map((p) => p.date)))].sort();

  return buckets.map((bucket) => {
    const row: ChartRow = { bucket: formatBucketLabel(bucket, granularity) };
    for (const series of seriesList) {
      // Bucket ausente vira 0, não `undefined` — senão a linha ganha um furo.
      row[SOURCE_LABEL[series.source]] = series.points.find((p) => p.date === bucket)?.value ?? 0;
    }
    return row;
  });
}

/**
 * Tooltip própria em vez da padrão do Recharts: a padrão imprime o número cru,
 * e valores monetários chegam aqui em CENTAVOS. Sem `formatMetricValue`, o
 * usuário leria "480000" onde são R$ 4.800,00.
 */
function ChartTooltip({ active, payload, label, unit }: TooltipProps<number, string> & { unit: MetricUnit }) {
  if (!active || !payload?.length) return null;

  return (
    <div
      className="rounded-md border px-3 py-2 text-sm shadow-sm"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
    >
      <p className="mb-1 font-medium" style={{ color: 'var(--text-primary)' }}>{label}</p>
      {payload.map((entry) => (
        <p key={String(entry.dataKey)} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-sm"
            style={{ backgroundColor: entry.color }}
          />
          <span style={{ color: 'var(--text-secondary)' }}>{entry.name}</span>
          <span className="ml-auto tabular-nums" style={{ color: 'var(--text-primary)' }}>
            {formatMetricValue(Number(entry.value ?? 0), unit)}
          </span>
        </p>
      ))}
    </div>
  );
}

export function TimeSeriesChart({
  title, description, seriesList, granularity, unit, isLoading = false, error = null,
}: TimeSeriesChartProps) {
  const rows = buildRows(seriesList, granularity);
  const categories = seriesList.map((series) => SOURCE_LABEL[series.source]);

  return (
    <ChartFrame
      title={title}
      {...(description ? { description } : {})}
      tableColumns={['Período', ...categories]}
      tableRows={rows.map((row) => [
        String(row.bucket),
        ...categories.map((category) => formatMetricValue(Number(row[category] ?? 0), unit)),
      ])}
      isLoading={isLoading}
      error={error}
    >
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
            <defs>
              {seriesList.map((series) => (
                <linearGradient
                  key={series.source}
                  id={`fill-${series.source}`}
                  x1="0" y1="0" x2="0" y2="1"
                >
                  {/* Preenchimento discreto: a área dá contexto, a linha carrega o dado. */}
                  <stop offset="0%" stopColor={SERIES_COLOR_BY_SOURCE[series.source]} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={SERIES_COLOR_BY_SOURCE[series.source]} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>

            {/* Grade recessiva: só horizontal, cor de hairline. */}
            <CartesianGrid stroke="var(--gridline)" strokeDasharray="0" vertical={false} />

            <XAxis
              dataKey="bucket"
              tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--gridline)' }}
              minTickGap={24}
            />
            <YAxis
              width={80}
              tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => formatMetricValue(value, unit)}
            />

            <Tooltip
              content={<ChartTooltip unit={unit} />}
              cursor={{ stroke: 'var(--text-muted)', strokeWidth: 1 }}
            />

            {/* Legenda só com 2+ séries: com uma, o título já a nomeia. */}
            {categories.length > 1 ? (
              <Legend
                verticalAlign="bottom"
                height={28}
                iconType="square"
                wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }}
              />
            ) : null}

            {seriesList.map((series) => (
              <Area
                key={series.source}
                type="monotone"
                dataKey={SOURCE_LABEL[series.source]}
                stroke={SERIES_COLOR_BY_SOURCE[series.source]}
                strokeWidth={2}
                fill={`url(#fill-${series.source})`}
                // Sem ponto em cada bucket: só o do hover. Rotular todos os
                // pontos é o anti-padrão que polui a leitura da linha.
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
