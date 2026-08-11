import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';
import type { MetricGateway } from '@center/mcp-core';
import type { TenantContext } from '@center/shared';
import { buildAgentTools, type AgentToolCall } from './tools.js';
import { buildSystemPrompt } from './system-prompt.js';

export { buildSystemPrompt };

export const MAX_HISTORY_MESSAGES = 12;
export const MAX_REPLY_CHARS = 1200;
/** Perguntas cruzadas legitimamente encadeiam 3-4 ferramentas; 8 dá folga sem virar laço. */
export const MAX_STEPS = 8;

const FALLBACK_REPLY = 'Não consegui consultar os dados agora. Tente de novo em alguns instantes.';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentInput {
  gateway: MetricGateway;
  tenant: TenantContext;
  today: string;
  history: AgentMessage[];
  userMessage: string;
  /** Injetável para teste; em produção vem de `defaultModel()`. */
  model?: LanguageModel;
}

export interface AgentResult {
  reply: string;
  toolCalls: AgentToolCall[];
}

export function defaultModel(apiKey: string): LanguageModel {
  return createAnthropic({ apiKey })('claude-sonnet-5');
}

function truncate(text: string): string {
  return text.length <= MAX_REPLY_CHARS ? text : `${text.slice(0, MAX_REPLY_CHARS - 1)}…`;
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const toolCalls: AgentToolCall[] = [];

  const tools = buildAgentTools({
    gateway: input.gateway,
    tenant: input.tenant,
    today: input.today,
    onToolCall: (log) => toolCalls.push(log),
  });

  // Janela deslizante: conversas longas estourariam o contexto e o custo, e o
  // histórico antigo raramente ajuda numa pergunta sobre números.
  const recentHistory = input.history.slice(-MAX_HISTORY_MESSAGES);

  const messages: ModelMessage[] = [
    ...recentHistory.map((message) => ({ role: message.role, content: message.content })),
    { role: 'user' as const, content: input.userMessage },
  ];

  try {
    const result = await generateText({
      model: input.model ?? defaultModel(process.env.ANTHROPIC_API_KEY ?? ''),
      system: buildSystemPrompt(input.today),
      messages,
      tools,
      // Sem este limite, uma ferramenta que falha em laço queima a cota da API.
      stopWhen: stepCountIs(MAX_STEPS),
      temperature: 0,
    });

    const text = result.text.trim();
    return { reply: text === '' ? FALLBACK_REPLY : truncate(text), toolCalls };
  } catch (error) {
    // Falha do provedor não pode virar 500 no webhook: o usuário precisa
    // receber uma mensagem, e a Meta precisa receber 200 — por isso este
    // catch NUNCA relança. Mas engolir o erro em silêncio é exatamente como
    // uma ANTHROPIC_API_KEY inválida/expirada vira "toda resposta do
    // WhatsApp é o fallback", sem nenhum sinal em lugar nenhum: o log daqui é
    // a ÚNICA visibilidade que existe, porque `whatsapp/worker.ts` só loga
    // quando `runAgent` lança — o que ele nunca faz, precisamente por causa
    // deste catch.
    console.error('runAgent: provedor de modelo falhou, devolvendo resposta de fallback', error);
    return { reply: FALLBACK_REPLY, toolCalls };
  }
}
