import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import type { AppConfig } from '../config.js';
import { resolveTenant } from '../tenant.js';
import { runAgent } from '../agent/agent.js';
import { appendExchange, loadConversationHistory } from '../agent/memory.js';
import type { CloudApiClient } from './cloud-api-client.js';
import type { InboundMessage } from './parse.js';
import { WHATSAPP_QUEUE_NAME } from './queue.js';
import { LINK_CODE_TTL_MINUTES, isLinkCodeMessage, redeemLinkCode } from './linking.js';

export const UNKNOWN_PHONE_REPLY =
  'Não encontrei este número vinculado a uma conta. Entre na dashboard, gere um código de '
  + 'vínculo em Configurações e me envie aqui.';

const AGENT_FAILURE_REPLY = 'Não consegui processar sua pergunta agora. Tente novamente em alguns instantes.';

export interface WorkerDeps {
  prisma: PrismaClient;
  gateway: MetricGateway;
  cloudApi: CloudApiClient;
  config: AppConfig;
  today?: () => string;
}

function todayInSaoPaulo(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

export async function processInboundMessage(deps: WorkerDeps, message: InboundMessage): Promise<void> {
  const identity = await deps.prisma.whatsAppIdentity.findUnique({
    where: { phoneE164: message.fromPhoneE164 },
  });

  // Fronteira de autorização do bot: número não vinculado e verificado nunca
  // chega ao agente, então nunca toca em dado de nenhuma organização.
  if (!identity || !identity.verifiedAt) {
    // O código de vínculo só é interpretado para números AINDA não
    // vinculados/verificados. `isLinkCodeMessage` casa qualquer palavra de 6
    // caracteres do alfabeto Crockford (ex.: "VENDAS", "MARGEM") — um usuário
    // JÁ verificado não tem motivo para reenviar um código, então checar isso
    // aqui dentro (e não antes da busca de identidade) evita sequestrar uma
    // pergunta real de quem já está vinculado.
    if (isLinkCodeMessage(message.text)) {
      const result = await redeemLinkCode(deps.prisma, message.text, message.fromPhoneE164);
      const replyText = result.ok
        ? 'Pronto! Este número está vinculado à sua conta. Pode perguntar sobre suas métricas. 📊'
        : {
            not_found: 'Código não encontrado. Gere um novo na dashboard, em Configurações.',
            expired: `Código expirado — ele vale ${LINK_CODE_TTL_MINUTES} minutos. Gere um novo na dashboard.`,
            used: 'Este código já foi usado. Gere um novo na dashboard, em Configurações.',
            phone_taken: 'Este número já está vinculado a outro usuário. Fale com o administrador da conta.',
          }[result.reason];

      await deps.cloudApi.sendText(message.fromPhoneE164, replyText);
      return;
    }

    await deps.cloudApi.sendText(message.fromPhoneE164, UNKNOWN_PHONE_REPLY);
    return;
  }

  const today = (deps.today ?? todayInSaoPaulo)();

  let reply = AGENT_FAILURE_REPLY;
  let toolCalls: Awaited<ReturnType<typeof runAgent>>['toolCalls'] = [];
  let conversationId: string | null = null;

  try {
    const conversation = await loadConversationHistory(deps.prisma, identity.id, identity.organizationId);
    conversationId = conversation.conversationId;

    const tenant = await resolveTenant(deps.prisma, identity.organizationId);
    const result = await runAgent({
      gateway: deps.gateway, tenant, today,
      history: conversation.history, userMessage: message.text,
    });
    reply = result.reply;
    toolCalls = result.toolCalls;
  } catch (error) {
    // Falha no agente ou no banco não pode impedir a resposta: silêncio no
    // WhatsApp é pior do que uma mensagem de erro. Mas a falha precisa ficar
    // visível — sem log, o job ainda é reportado como "completed" pelo
    // BullMQ (a função não relança), e não haveria nenhum sinal de que todo
    // usuário está recebendo só a resposta de fallback.
    console.error(`worker do WhatsApp: falha ao processar wamid=${message.wamid}`, error);
  }

  // Deliberadamente fora do try: se o envio falhar, a exceção sobe e o BullMQ
  // reprocessa o job.
  await deps.cloudApi.sendText(message.fromPhoneE164, reply);

  if (conversationId) {
    await appendExchange(deps.prisma, {
      conversationId,
      organizationId: identity.organizationId,
      userMessage: message.text,
      assistantMessage: reply,
      toolCalls,
    }).catch(() => {
      // Auditoria é best-effort; o usuário já foi respondido.
    });
  }
}

export function createWhatsAppWorker(deps: WorkerDeps, redis: Redis): Worker<InboundMessage> {
  return new Worker<InboundMessage>(
    WHATSAPP_QUEUE_NAME,
    async (job) => processInboundMessage(deps, job.data),
    { connection: redis, concurrency: 5 },
  );
}
