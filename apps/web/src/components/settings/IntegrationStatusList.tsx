import { useQuery } from '@tanstack/react-query';
import { apiClient, type IntegrationKind, type IntegrationStatus } from '../../lib/api-client.js';

const KIND_LABELS: Record<IntegrationKind, string> = {
  COMMERCE: 'Loja (e-commerce)',
  WEB_ANALYTICS: 'Google Analytics do site',
  APP_ANALYTICS: 'Analytics do app',
  PLAY_STORE: 'Google Play',
  APP_STORE: 'App Store',
  SPRINT_BOARD: 'Board do Monday',
};

const STATUS_LABELS: Record<IntegrationStatus, string> = {
  OK: 'Conectada',
  ERROR: 'Com erro',
  PENDING: 'Aguardando configuração',
  DISABLED: 'Desativada',
};

const STATUS_STYLES: Record<IntegrationStatus, string> = {
  OK: 'bg-green-100 text-green-800',
  ERROR: 'bg-red-100 text-red-800',
  PENDING: 'bg-amber-100 text-amber-800',
  DISABLED: 'bg-gray-100 text-gray-600',
};

const dateFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' });

/**
 * Painel só de leitura: mostra o status de cada integração. As credenciais são
 * configuradas pelo backoffice — aqui não existe nenhum campo de entrada.
 */
export function IntegrationStatusList() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['settings', 'integrations'],
    queryFn: () => apiClient.getIntegrations(),
  });

  if (isLoading) return <p className="text-sm text-gray-500">Carregando…</p>;
  if (isError || !data) return <p className="text-sm text-red-600">Não foi possível carregar as integrações.</p>;
  if (data.integrations.length === 0) {
    return <p className="text-sm text-gray-500">Nenhuma integração configurada.</p>;
  }

  return (
    <ul className="divide-y rounded border">
      {data.integrations.map((item) => (
        <li key={item.kind} className="flex items-center justify-between gap-4 p-3">
          <div>
            <p className="font-medium">{KIND_LABELS[item.kind]}</p>
            {item.lastSyncedAt && (
              <p className="text-xs text-gray-500">
                Última sincronização: {dateFormat.format(new Date(item.lastSyncedAt))}
              </p>
            )}
          </div>
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[item.status]}`}>
            {STATUS_LABELS[item.status]}
          </span>
        </li>
      ))}
    </ul>
  );
}
