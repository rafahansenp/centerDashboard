import { useState, type ReactNode } from 'react';

interface ChartFrameProps {
  title: string;
  description?: string;
  tableColumns: string[];
  tableRows: string[][];
  isLoading?: boolean;
  error?: Error | null;
  children: ReactNode;
}

/**
 * Envelope de todo gráfico. Três das quatro cores do modo claro ficam abaixo de
 * 3:1 de contraste com a superfície — a visão de tabela não é um extra, é o
 * mecanismo de relevo que torna o gráfico legível para quem não distingue as
 * cores. Por isso vive aqui, e não em cada gráfico.
 */
export function ChartFrame({
  title, description, tableColumns, tableRows, isLoading = false, error = null, children,
}: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false);
  const isEmpty = !isLoading && !error && tableRows.length === 0;

  return (
    <section
      className="rounded-lg border p-4"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
      aria-label={title}
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>{description}</p>
          ) : null}
        </div>
        {!error && !isLoading && tableRows.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowTable((current) => !current)}
            className="shrink-0 rounded-md border px-2 py-1 text-xs"
            style={{ borderColor: 'var(--hairline)', color: 'var(--text-secondary)' }}
          >
            {showTable ? 'Ver como gráfico' : 'Ver como tabela'}
          </button>
        ) : null}
      </div>

      {isLoading ? (
        <div role="status" className="h-64 animate-pulse rounded-md" style={{ backgroundColor: 'var(--gridline)' }}>
          <span className="sr-only">Carregando dados de {title}</span>
        </div>
      ) : error ? (
        <div role="alert" className="rounded-md p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <strong className="block font-medium" style={{ color: 'var(--critical)' }}>
            Não foi possível carregar
          </strong>
          {error.message}
        </div>
      ) : isEmpty ? (
        <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Sem dados no período selecionado
        </p>
      ) : showTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {tableColumns.map((column) => (
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
              {tableRows.map((row) => (
                <tr key={row.join('|')}>
                  {row.map((cell, index) => (
                    <td
                      key={`${row[0]}-${index}`}
                      className={`border-b px-2 py-1.5 ${index === 0 ? '' : 'tabular-nums'}`}
                      style={{ borderColor: 'var(--gridline)', color: 'var(--text-primary)' }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </section>
  );
}
