/**
 * Erro cuja mensagem foi escrita por nós propositalmente para ser lida pelo
 * modelo de LLM do agente de WhatsApp (`agent/tools.ts`) — período não
 * entendido, ranking desconhecido, data de lançamento no futuro — e por isso
 * é segura para repassar sem scrubbing.
 *
 * Qualquer outro erro que chegue a uma ferramenta do agente (`McpToolError`,
 * falha do Prisma, timeout de rede) carrega texto de um sistema upstream e
 * NUNCA deve chegar ao modelo cru: mesma política já aplicada em
 * `upstreamError` (`routes/metrics.ts`) para o cliente HTTP — mensagem
 * genérica para fora, mensagem real só no log de auditoria
 * (`AgentToolCall.errorMessage` / `ToolCallLog`).
 */
export class AgentGuidanceError extends Error {}
