import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/jwt.js';
import { resolveTenant } from '../tenant.js';
import { runAgent } from '../agent/agent.js';
import { appendExchange, loadUserConversationHistory } from '../agent/memory.js';
import type { AppDeps } from '../deps.js';

const AskBodySchema = z.object({
  message: z.string().min(1, 'mensagem vazia').max(2000, 'mensagem muito longa (máximo 2000 caracteres)'),
});

/** Mesma regra de `apps/api/src/whatsapp/worker.ts` — "hoje" nunca é `new Date()` dentro da lógica de negócio. */
function todayInSaoPaulo(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

/**
 * Canal interno do agente: mesma lógica (`runAgent`) que o WhatsApp usa,
 * só que autenticado pelo login do painel em vez de um número de telefone
 * vinculado — nenhum webhook público, nenhuma credencial da Meta envolvida.
 */
export async function registerAgentRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/agent/conversation', { preHandler: requireAuth }, async (request, reply) => {
    const conversation = await loadUserConversationHistory(
      deps.prisma, request.auth.userId, request.auth.organizationId,
    );
    return reply.send({ conversationId: conversation.conversationId, messages: conversation.history });
  });

  app.post('/api/agent/ask', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = AskBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'bad_request', message: parsed.error.issues[0]?.message ?? 'corpo inválido' });
    }

    const conversation = await loadUserConversationHistory(
      deps.prisma, request.auth.userId, request.auth.organizationId,
    );
    const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
    const today = todayInSaoPaulo();

    const result = await runAgent({
      gateway: deps.gateway, tenant, today,
      history: conversation.history, userMessage: parsed.data.message,
    });

    // Best-effort: o usuário já recebeu a resposta na chamada HTTP, uma
    // falha ao persistir o histórico não pode virar erro pra ele.
    await appendExchange(deps.prisma, {
      conversationId: conversation.conversationId,
      organizationId: request.auth.organizationId,
      userMessage: parsed.data.message,
      assistantMessage: result.reply,
      toolCalls: result.toolCalls,
    }).catch(() => {});

    return reply.send({ conversationId: conversation.conversationId, reply: result.reply });
  });
}
