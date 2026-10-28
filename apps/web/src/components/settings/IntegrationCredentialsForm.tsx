import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type IntegrationsUpdate } from '../../lib/api-client.js';

const QUERY_KEY = ['settings', 'integrations'];

/**
 * Campos de segredo (apiKey/secretKey) NUNCA vêm preenchidos: o backend nunca
 * devolve o valor em claro (T24B), só se está configurado ou não. Um campo
 * deixado vazio no submit significa "não mudar", nunca "apagar" — só um botão
 * de remoção explícito (fora de escopo aqui) apagaria uma credencial.
 */
export function IntegrationCredentialsForm() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: QUERY_KEY, queryFn: () => apiClient.getIntegrations() });

  const [uappiApiKey, setUappiApiKey] = useState('');
  const [uappiSecretKey, setUappiSecretKey] = useState('');
  const [ga4PropertyId, setGa4PropertyId] = useState('');
  const [ga4BigQueryDataset, setGa4BigQueryDataset] = useState('');

  // Só os campos não-secretos são pré-preenchidos, e só quando o valor do
  // servidor chega — evita sobrescrever o que o admin já digitou num refetch.
  useEffect(() => {
    if (data) {
      setGa4PropertyId(data.ga4.propertyId ?? '');
      setGa4BigQueryDataset(data.ga4.bigQueryDataset ?? '');
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (patch: IntegrationsUpdate) => apiClient.updateIntegrations(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(QUERY_KEY, updated);
      // Os segredos nunca voltam do servidor — limpar aqui é o que impede um
      // valor sensível de continuar visível na tela depois de salvo.
      setUappiApiKey('');
      setUappiSecretKey('');
    },
  });

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const patch: IntegrationsUpdate = {};
    if (uappiApiKey.trim()) patch.uappiApiKey = uappiApiKey.trim();
    if (uappiSecretKey.trim()) patch.uappiSecretKey = uappiSecretKey.trim();
    if (ga4PropertyId.trim()) patch.ga4PropertyId = ga4PropertyId.trim();
    if (ga4BigQueryDataset.trim()) patch.ga4BigQueryDataset = ga4BigQueryDataset.trim();
    mutation.mutate(patch);
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-6">
      <div className="space-y-3 rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Uappi</h3>
          <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={
              data?.uappi.configured
                ? { backgroundColor: 'var(--good)', color: 'white' }
                : { backgroundColor: 'var(--gridline)', color: 'var(--text-secondary)' }
            }
          >
            {data?.uappi.configured ? 'Configurado' : 'Não configurado'}
          </span>
        </div>

        <div className="space-y-1">
          <label htmlFor="uappiApiKey" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
            Chave de API da Uappi
          </label>
          <input
            id="uappiApiKey" name="uappiApiKey" type="password" autoComplete="off"
            value={uappiApiKey} onChange={(event) => setUappiApiKey(event.target.value)}
            placeholder={data?.uappi.configured ? '••••••••' : 'apiKey'}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)', color: 'var(--text-primary)' }}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="uappiSecretKey" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
            Chave secreta da Uappi
          </label>
          <input
            id="uappiSecretKey" name="uappiSecretKey" type="password" autoComplete="off"
            value={uappiSecretKey} onChange={(event) => setUappiSecretKey(event.target.value)}
            placeholder={data?.uappi.configured ? '••••••••' : 'secretKey'}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)', color: 'var(--text-primary)' }}
          />
        </div>
      </div>

      <div className="space-y-3 rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Google Analytics 4</h3>

        <div className="space-y-1">
          <label htmlFor="ga4PropertyId" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
            ID da propriedade GA4
          </label>
          <input
            id="ga4PropertyId" name="ga4PropertyId" type="text"
            value={ga4PropertyId} onChange={(event) => setGa4PropertyId(event.target.value)}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)', color: 'var(--text-primary)' }}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="ga4BigQueryDataset" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
            Dataset do BigQuery
          </label>
          <input
            id="ga4BigQueryDataset" name="ga4BigQueryDataset" type="text"
            value={ga4BigQueryDataset} onChange={(event) => setGa4BigQueryDataset(event.target.value)}
            placeholder="analytics_123456789"
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)', color: 'var(--text-primary)' }}
          />
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Necessário só para as duas perguntas de comportamento avançado (Fase 8).</p>
        </div>
      </div>

      {mutation.isError ? (
        <p role="alert" className="text-sm" style={{ color: 'var(--critical)' }}>
          {(mutation.error as Error).message}
        </p>
      ) : null}

      <button
        type="submit" disabled={mutation.isPending}
        className="rounded-md bg-accent px-4 py-2 text-white disabled:opacity-60"
      >
        {mutation.isPending ? 'Salvando…' : 'Salvar'}
      </button>
    </form>
  );
}
