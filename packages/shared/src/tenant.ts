import { z } from 'zod';

/**
 * Obrigatório em toda consulta. `externalIds` carrega os identificadores da
 * organização em cada fonte — cada MCP server lê só a chave que lhe interessa,
 * e nenhum server guarda estado de tenant.
 *
 * Chaves conhecidas: `ga4PropertyId`, `ga4BigQueryDataset`.
 *
 * SÓ IDENTIFICADORES, NUNCA CREDENCIAIS. Este objeto atravessa o canal stdio de
 * todos os MCP servers e entra no hash da chave de cache; um segredo aqui
 * viraria segredo espalhado por processos que não precisam dele. Quem precisa
 * de credencial a lê do banco e decifra por conta própria (T15, T24).
 */
export const TenantContextSchema = z.object({
  organizationId: z.string().min(1),
  externalIds: z.record(z.string(), z.string()),
});

export type TenantContext = z.infer<typeof TenantContextSchema>;
