import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { ChartFrame } from './ChartFrame.js';

interface CategoryLineChartProps {
  title: string;
  description?: string;
  points: Array<{ x: string; y: number }>;
  color: string;
  height?: number;
  isLoading?: boolean;
  error?: Error | null;
}

function LineTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-md border px-3 py-2 text-sm shadow-sm"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
    >
      <p className="mb-1 font-medium" style={{ color: 'var(--text-primary)' }}>{label}</p>
      <p className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>{payload[0]?.value}</p>
    </div>
  );
}

/**
 * Uma série, um eixo — para os pequenos múltiplos de sprint (Tasks,
 * Melhorias, Análises, Correção) e para "Tasks por Sprint". Linha fina, sem
 * ponto fixo (só no hover), grade só horizontal — mesma convenção de
 * `TimeSeriesChart`, sem a área preenchida: são vários gráficos lado a lado,
 * e o preenchimento pesaria a leitura em conjunto.
 */
export function CategoryLineChart({
  title, description, points, color, height = 160, isLoading = false, error = null,
}: CategoryLineChartProps) {
  return (
    <ChartFrame
      title={title}
      {...(description ? { description } : {})}
      tableColumns={['Período', title]}
      tableRows={points.map((point) => [point.x, String(point.y)])}
      isLoading={isLoading}
      error={error}
    >
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--gridline)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="x"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--gridline)' }}
              minTickGap={16}
            />
            <YAxis
              width={32}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            <Tooltip content={<LineTooltip />} cursor={{ stroke: 'var(--text-muted)', strokeWidth: 1 }} />
            <Line
              type="monotone"
              dataKey="y"
              stroke={color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
