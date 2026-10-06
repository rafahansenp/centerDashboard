import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type AgentMessageView } from '../../lib/api-client.js';

const QUERY_KEY = ['agent', 'conversation'];

function Bubble({ message }: { message: AgentMessageView }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
        style={isUser
          ? { backgroundColor: 'var(--accent)', color: '#fff' }
          : { backgroundColor: 'var(--surface-1)', border: '1px solid var(--hairline)', color: 'var(--text-primary)' }}
      >
        {message.content}
      </div>
    </div>
  );
}

/**
 * Corpo do chat com o agente — sem moldura de página, pra ser embutido tanto
 * no widget flutuante quanto em qualquer outro lugar no futuro. Mesma lógica
 * de sempre: mesmo agente do WhatsApp, canal interno, autenticado.
 */
export function AssistantChat() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [localMessages, setLocalMessages] = useState<AgentMessageView[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversation = useQuery({ queryKey: QUERY_KEY, queryFn: apiClient.getAgentConversation });

  useEffect(() => {
    if (conversation.data) setLocalMessages(conversation.data.messages);
  }, [conversation.data]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [localMessages]);

  const ask = useMutation({
    mutationFn: (message: string) => apiClient.askAgent(message),
    onSuccess: (result) => {
      setLocalMessages((current) => [...current, { role: 'assistant', content: result.reply }]);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const send = () => {
    const message = draft.trim();
    if (!message || ask.isPending) return;
    setLocalMessages((current) => [...current, { role: 'user', content: message }]);
    setDraft('');
    ask.mutate(message);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite">
        {conversation.isLoading ? (
          <p role="status" className="text-sm" style={{ color: 'var(--text-muted)' }}>Carregando conversa…</p>
        ) : localMessages.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Pergunte algo como "quanto vendemos este mês?".
          </p>
        ) : (
          localMessages.map((message, index) => <Bubble key={index} message={message} />)
        )}
        {ask.isPending ? (
          <p role="status" className="text-sm" style={{ color: 'var(--text-muted)' }}>Pensando…</p>
        ) : null}
        {ask.error ? (
          <p role="alert" className="text-sm" style={{ color: 'var(--critical)' }}>
            {(ask.error as Error).message}
          </p>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2 border-t p-3"
        style={{ borderColor: 'var(--hairline)' }}
        onSubmit={(event) => { event.preventDefault(); send(); }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Pergunte algo sobre os dados…"
          disabled={ask.isPending}
          autoFocus
          className="flex-1 rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)', color: 'var(--text-primary)' }}
        />
        <button
          type="submit"
          disabled={ask.isPending || draft.trim() === ''}
          className="rounded-md bg-accent px-4 py-2 text-sm text-white disabled:opacity-60"
        >
          Enviar
        </button>
      </form>
    </div>
  );
}
