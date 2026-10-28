import { useState } from 'react';
import { useFilters } from '../hooks/use-filters.js';
import { useTool } from '../hooks/use-tool.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { RankingTable } from '../components/charts/RankingTable.js';
import { FunnelChart } from '../components/charts/FunnelChart.js';
import { formatMetricValue } from '../lib/format.js';
import type { RankingResult, FunnelResult } from '../lib/api-client.js';

interface CompareByVersionResult {
  versionA: string; versionB: string;
  rows: Array<{
    key: string; label: string; valueA: number; valueB: number;
    shareA: number; shareB: number; delta: number; deltaRatio: number | null;
  }>;
}

// Mesma lista de packages/mcp-firebase/src/dimensions.ts (APP_VERSIONS) — não
// há ainda uma fonte real do Firebase que liste versões dinamicamente, então
// o front espelha a mesma fixture. Da mais recente para a mais antiga.
const APP_VERSIONS = ['2.4.0', '2.3.1', '2.2.0', '2.1.0'] as const;

function versionLabel(version: string): string {
  return version === APP_VERSIONS[0] ? `${version} (última)` : version;
}

const percent = new Intl.NumberFormat('pt-BR', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero',
});
const plainPercent = new Intl.NumberFormat('pt-BR', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
});

export function AppUsagePage({ today }: { today: string }) {
  const { filters } = useFilters(today);
  const period = { from: filters.from, to: filters.to };

  const [versionA, setVersionA] = useState<string>(APP_VERSIONS[1]);
  const [versionB, setVersionB] = useState<string>(APP_VERSIONS[0]);

  const usage = useTool<RankingResult>('firebase', 'usage_summary', { ...period, limit: 20 });
  const funnel = useTool<FunnelResult>('firebase', 'shop_funnel', period);
  const compare = useTool<CompareByVersionResult>('firebase', 'compare_by_version', {
    ...period, versionA, versionB,
  });

  const asError = (value: unknown) => (value instanceof Error ? value : null);

  return (
    <div className="space-y-6">
      <PeriodPicker today={today} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RankingTable
          title="Uso por módulo"
          description="Usuários ativos por evento do app (cadastro, treino, dieta, alimentos, exercícios e loja) no período."
          result={usage.data}
          isLoading={usage.isLoading}
          error={asError(usage.error)}
        />
        <FunnelChart title="Funil da loja dentro do app" result={funnel.data} isLoading={funnel.isLoading} error={asError(funnel.error)} />
      </div>

      <section
        className="rounded-lg border p-4"
        style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
        aria-label="Comparação de versões"
      >
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Comparação de versões</h3>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          Contagem de usuários por evento e % do total de usuários daquela versão, no mesmo período.
        </p>
        {asError(compare.error) ? (
          <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--critical)' }}>
            {(compare.error as Error).message}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>Evento</th>
                  <th scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>
                    <select
                      value={versionA}
                      onChange={(event) => setVersionA(event.target.value)}
                      aria-label="Versão A"
                      className="rounded-md border px-2 py-1 text-sm font-medium"
                      style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)', color: 'var(--text-primary)' }}
                    >
                      {APP_VERSIONS.filter((version) => version !== versionB).map((version) => (
                        <option key={version} value={version}>{versionLabel(version)}</option>
                      ))}
                    </select>
                  </th>
                  <th scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>
                    <select
                      value={versionB}
                      onChange={(event) => setVersionB(event.target.value)}
                      aria-label="Versão B"
                      className="rounded-md border px-2 py-1 text-sm font-medium"
                      style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)', color: 'var(--text-primary)' }}
                    >
                      {APP_VERSIONS.filter((version) => version !== versionA).map((version) => (
                        <option key={version} value={version}>{versionLabel(version)}</option>
                      ))}
                    </select>
                  </th>
                  <th scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>Variação</th>
                </tr>
              </thead>
              <tbody>
                {(compare.data?.rows ?? []).map((row) => (
                  <tr key={row.key}>
                    <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{row.label}</td>
                    <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                      {formatMetricValue(row.valueA, 'count')} ({plainPercent.format(row.shareA)})
                    </td>
                    <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                      {formatMetricValue(row.valueB, 'count')} ({plainPercent.format(row.shareB)})
                    </td>
                    <td className="border-b px-2 py-1.5 tabular-nums" style={{
                      borderColor: 'var(--gridline)',
                      color: row.delta < 0 ? 'var(--critical)' : 'var(--good)',
                    }}>
                      {row.deltaRatio === null ? 'novo' : percent.format(row.deltaRatio)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
