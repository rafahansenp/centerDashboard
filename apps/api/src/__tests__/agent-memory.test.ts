import type { PrismaClient } from '@prisma/client';
import { MAX_LOADED_MESSAGES, appendExchange, loadConversationHistory, loadUserConversationHistory } from '../agent/memory.js';

function buildPrisma() {
  const conversation = {
    findFirst: jest.fn(async () => null),
    create: jest.fn(async () => ({ id: 'conv_new' })),
    update: jest.fn(async () => ({})),
  };
  const message = { findMany: jest.fn(async () => []), create: jest.fn(async () => ({ id: 'msg_1' })) };
  const toolCallLog = { createMany: jest.fn(async () => ({ count: 0 })) };
  return {
    prisma: { conversation, message, toolCallLog } as unknown as PrismaClient,
    conversation, message, toolCallLog,
  };
}

describe('loadConversationHistory', () => {
  it('creates a conversation on the first message', async () => {
    const { prisma, conversation } = buildPrisma();
    expect(await loadConversationHistory(prisma, 'wid_1', 'org_1'))
      .toEqual({ conversationId: 'conv_new', history: [] });
    expect(conversation.create).toHaveBeenCalledWith({
      data: { whatsappIdentityId: 'wid_1', organizationId: 'org_1' },
    });
  });

  it('reuses the conversation and returns history in chronological order', async () => {
    const { prisma, conversation, message } = buildPrisma();
    conversation.findFirst.mockResolvedValueOnce({ id: 'conv_1' } as never);
    // O Prisma devolve desc (mais recentes primeiro); a saída precisa ser asc.
    message.findMany.mockResolvedValueOnce([
      { role: 'ASSISTANT', content: 'resposta 2' },
      { role: 'USER', content: 'pergunta 2' },
      { role: 'ASSISTANT', content: 'resposta 1' },
      { role: 'USER', content: 'pergunta 1' },
    ] as never);

    const result = await loadConversationHistory(prisma, 'wid_1', 'org_1');
    expect(conversation.create).not.toHaveBeenCalled();
    expect(result.history).toEqual([
      { role: 'user', content: 'pergunta 1' },
      { role: 'assistant', content: 'resposta 1' },
      { role: 'user', content: 'pergunta 2' },
      { role: 'assistant', content: 'resposta 2' },
    ]);
  });

  it('caps how many messages it loads', async () => {
    const { prisma, conversation, message } = buildPrisma();
    conversation.findFirst.mockResolvedValueOnce({ id: 'conv_1' } as never);
    await loadConversationHistory(prisma, 'wid_1', 'org_1');
    expect(message.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: MAX_LOADED_MESSAGES }));
  });
});

describe('loadUserConversationHistory', () => {
  it('creates a conversation keyed by userId, not whatsappIdentityId', async () => {
    const { prisma, conversation } = buildPrisma();
    expect(await loadUserConversationHistory(prisma, 'user_1', 'org_1'))
      .toEqual({ conversationId: 'conv_new', history: [] });
    expect(conversation.create).toHaveBeenCalledWith({
      data: { userId: 'user_1', organizationId: 'org_1' },
    });
  });

  it('reuses the conversation and returns history in chronological order', async () => {
    const { prisma, conversation, message } = buildPrisma();
    conversation.findFirst.mockResolvedValueOnce({ id: 'conv_1' } as never);
    message.findMany.mockResolvedValueOnce([
      { role: 'ASSISTANT', content: 'resposta 1' },
      { role: 'USER', content: 'pergunta 1' },
    ] as never);

    const result = await loadUserConversationHistory(prisma, 'user_1', 'org_1');
    expect(conversation.create).not.toHaveBeenCalled();
    expect(result.history).toEqual([
      { role: 'user', content: 'pergunta 1' },
      { role: 'assistant', content: 'resposta 1' },
    ]);
  });

  it('never filters by whatsappIdentityId', async () => {
    const { prisma, conversation } = buildPrisma();
    await loadUserConversationHistory(prisma, 'user_1', 'org_1');
    expect(conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user_1' },
    }));
  });
});

describe('appendExchange', () => {
  it('persists the user message, the reply and the tool logs', async () => {
    const { prisma, message, toolCallLog, conversation } = buildPrisma();
    message.create
      .mockResolvedValueOnce({ id: 'msg_user' } as never)
      .mockResolvedValueOnce({ id: 'msg_assistant' } as never);

    await appendExchange(prisma, {
      conversationId: 'conv_1', organizationId: 'org_1',
      userMessage: 'quanto vendemos?', assistantMessage: 'R$ 4.800,00',
      toolCalls: [{ toolName: 'consultar_metrica', input: { metricId: 'commerce.revenue' }, durationMs: 42, success: true }],
    });

    expect(message.create).toHaveBeenCalledTimes(2);
    expect(message.create).toHaveBeenNthCalledWith(1, {
      data: { conversationId: 'conv_1', role: 'USER', content: 'quanto vendemos?' },
    });
    expect(toolCallLog.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ messageId: 'msg_assistant', organizationId: 'org_1', success: true })],
    });
    expect(conversation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conv_1' } }));
  });

  it('records the error message of a failed tool call', async () => {
    const { prisma, message, toolCallLog } = buildPrisma();
    message.create
      .mockResolvedValueOnce({ id: 'msg_user' } as never)
      .mockResolvedValueOnce({ id: 'msg_assistant' } as never);

    await appendExchange(prisma, {
      conversationId: 'conv_1', organizationId: 'org_1',
      userMessage: 'p', assistantMessage: 'r',
      toolCalls: [{ toolName: 'consultar_metrica', input: {}, durationMs: 5, success: false, errorMessage: 'Uappi 503' }],
    });
    expect(toolCallLog.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ success: false, errorMessage: 'Uappi 503' })],
    });
  });

  it('skips the tool log write when there were no tool calls', async () => {
    const { prisma, message, toolCallLog } = buildPrisma();
    message.create
      .mockResolvedValueOnce({ id: 'msg_user' } as never)
      .mockResolvedValueOnce({ id: 'msg_assistant' } as never);
    await appendExchange(prisma, {
      conversationId: 'conv_1', organizationId: 'org_1',
      userMessage: 'oi', assistantMessage: 'olá', toolCalls: [],
    });
    expect(toolCallLog.createMany).not.toHaveBeenCalled();
  });
});
