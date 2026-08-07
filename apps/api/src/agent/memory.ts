import type { PrismaClient } from '@prisma/client';
import type { AgentMessage } from './agent.js';
import type { AgentToolCall } from './tools.js';

/** Teto do que sai do banco. A janela enviada ao modelo é menor. */
export const MAX_LOADED_MESSAGES = 20;

export async function loadConversationHistory(
  prisma: PrismaClient,
  whatsappIdentityId: string,
  organizationId: string,
): Promise<{ conversationId: string; history: AgentMessage[] }> {
  const existing = await prisma.conversation.findFirst({
    where: { whatsappIdentityId },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });

  if (!existing) {
    const created = await prisma.conversation.create({
      data: { whatsappIdentityId, organizationId },
    });
    return { conversationId: created.id, history: [] };
  }

  // Buscamos em ordem decrescente para pegar as N MAIS RECENTES, depois
  // invertemos: o modelo precisa da conversa em ordem cronológica.
  const rows = await prisma.message.findMany({
    where: { conversationId: existing.id },
    orderBy: { createdAt: 'desc' },
    take: MAX_LOADED_MESSAGES,
    select: { role: true, content: true },
  });

  return {
    conversationId: existing.id,
    history: rows.reverse().map((row) => ({
      role: row.role === 'USER' ? ('user' as const) : ('assistant' as const),
      content: row.content,
    })),
  };
}

export interface AppendExchangeParams {
  conversationId: string;
  organizationId: string;
  userMessage: string;
  assistantMessage: string;
  toolCalls: AgentToolCall[];
}

export async function appendExchange(prisma: PrismaClient, params: AppendExchangeParams): Promise<void> {
  await prisma.message.create({
    data: { conversationId: params.conversationId, role: 'USER', content: params.userMessage },
  });

  const assistantMessage = await prisma.message.create({
    data: { conversationId: params.conversationId, role: 'ASSISTANT', content: params.assistantMessage },
  });

  if (params.toolCalls.length > 0) {
    await prisma.toolCallLog.createMany({
      data: params.toolCalls.map((call) => ({
        messageId: assistantMessage.id,
        organizationId: params.organizationId,
        toolName: call.toolName,
        input: call.input as object,
        durationMs: call.durationMs,
        success: call.success,
        errorMessage: call.errorMessage ?? null,
      })),
    });
  }

  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: { lastMessageAt: new Date() },
  });
}
