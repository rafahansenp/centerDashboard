import type { RankingResult } from '../../lib/api-client.js';
import { formatMetricValue } from '../../lib/format.js';

interface RankingTableProps {
  title: string;
  description?: string;
  result: RankingResult | undefined;
  isLoading?: boolean;
  error?: Error | null;
}

const percent = new Intl.NumberFormat('pt-BR', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
});

/**
 * Ranking é tabela, não gráfico de barras. Com nomes de produto de comprimento
 * variável, a barra rouba espaço do rótulo e o usuário perde a informação que
 * veio buscar — o nome. A participação percentual dá a proporção sem a barra.
 */
export function RankingTable({ title, description, result, isLoading = false, error = null }: RankingTableProps) {
  // A coluna some por completo quando o ranking não tem participação para
  // mostrar — melhor do que uma coluna inteira de trações, e muito melhor do
  // que o "NaN%" que sairia ao formatar um `share` ausente.
  const hasShare = result?.rows.some((row) => row.share !== undefined) ?? false;

  return (
    <section
      className="rounded-lg border p-4"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
      aria-label={title}
    >
      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
      {description ? (
        <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>{description}</p>
      ) : null}

      {isLoading ? (
        <div role="status" className="mt-3 h-48 animate-pulse rounded-md" style={{ backgroundColor: 'var(--gridline)' }}>
          <span className="sr-only">Carregando {title}</span>
        </div>
      ) : error ? (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--critical)' }}>{error.message}</p>
      ) : !result || result.rows.length === 0 ? (
        <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Sem dados no período selecionado
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {['#', 'Item', 'Valor', ...(hasShare ? ['Part.'] : [])].map((column) => (
                  <th
                    key={column} scope="col"
                    className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={row.key}>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)', color: 'var(--text-muted)' }}>
                    {index + 1}
                  </td>
                  <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)', color: 'var(--text-primary)' }}>
                    {row.label}
                  </td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)', color: 'var(--text-primary)' }}>
                    {formatMetricValue(row.value, row.unit)}
                  </td>
                  {hasShare ? (
                    <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>
                      {row.share === undefined ? '—' : percent.format(row.share)}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
