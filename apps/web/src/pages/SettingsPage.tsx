import { useMutation } from '@tanstack/react-query';
import { getAuthToken } from '../lib/api-client.js';

interface LinkCodeResponse { code: string; expiresAt: string; ttlMinutes: number }

async function requestLinkCode(): Promise<LinkCodeResponse> {
  const response = await fetch('/api/whatsapp/link-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getAuthToken() ?? ''}` },
  });
  if (!response.ok) throw new Error('Não foi possível gerar o código. Tente novamente.');
  return (await response.json()) as LinkCodeResponse;
}

export function SettingsPage() {
  const mutation = useMutation({ mutationFn: requestLinkCode });

  return (
    <section className="max-w-xl space-y-4">
      <h2 className="text-lg font-semibold">Vincular o WhatsApp</h2>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        Gere um código e envie-o pelo WhatsApp para o número do assistente. Ele vale alguns
        minutos e só pode ser usado uma vez.
      </p>

      <button type="button" onClick={() => mutation.mutate()} disabled={mutation.isPending}
        className="rounded-md bg-viz-1 px-4 py-2 text-white disabled:opacity-60">
        {mutation.isPending ? 'Gerando…' : 'Gerar código'}
      </button>

      {mutation.data ? (
        <div className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
          <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Seu código</p>
          <p className="mt-1 font-mono text-3xl tracking-[0.3em]">{mutation.data.code}</p>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Válido por {mutation.data.ttlMinutes} minutos.
          </p>
        </div>
      ) : null}

      {mutation.error ? (
        <p role="alert" className="text-sm" style={{ color: 'var(--critical)' }}>
          {(mutation.error as Error).message}
        </p>
      ) : null}
    </section>
  );
}
