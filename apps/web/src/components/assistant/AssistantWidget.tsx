import { useState } from 'react';
import { AssistantChat } from './AssistantChat.js';

/** Ícone simples de balão de conversa — sem depender de nenhuma lib de ícones. */
function ChatIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5C4 4.67 4.67 4 5.5 4h13c.83 0 1.5.67 1.5 1.5v10c0 .83-.67 1.5-1.5 1.5H9l-4 3.5v-3.5H5.5C4.67 17 4 16.33 4 15.5v-10Z"
        stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Botão flutuante sempre visível (fora do header, presente em toda tela
 * autenticada) — abre um painel de chat com o agente ao ser clicado. Vive no
 * AppShell, ao lado do <Outlet/>, então nenhuma rota precisa saber que ele existe.
 */
export function AssistantWidget() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open ? (
        <div
          role="dialog"
          aria-label="Assistente"
          className="fixed bottom-20 right-6 z-50 flex h-[28rem] w-[22rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border shadow-lg"
          style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
        >
          <div
            className="flex items-center justify-between rounded-t-xl border-b px-4 py-3"
            style={{ borderColor: 'var(--hairline)' }}
          >
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Assistente</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Fechar assistente"
              className="rounded-md p-1"
              style={{ color: 'var(--text-muted)' }}
            >
              <CloseIcon />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <AssistantChat />
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label={open ? 'Fechar assistente' : 'Abrir assistente'}
        aria-expanded={open}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg"
        style={{ backgroundColor: 'var(--viz-1)' }}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
      </button>
    </>
  );
}
