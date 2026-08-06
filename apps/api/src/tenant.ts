import type { PrismaClient } from '@prisma/client';
import type { TenantContext } from '@center/shared';

/**
 * Traduz a linha da Organization no TenantContext que os MCP servers consomem.
 * Ids não configurados são omitidos — assim o provider falha com "X não
 * configurado" em vez de mandar string vazia para a API externa.
 */
export async function resolveTenant(
  prisma: PrismaClient,
  organizationId: string,
): Promise<TenantContext> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, ga4PropertyId: true, ga4BigQueryDataset: true },
  });
  if (!organization) throw new Error(`organização não encontrada: ${organizationId}`);

  // SÓ IDENTIFICADORES, NUNCA CREDENCIAIS.
  //
  // `ga4PropertyId` e `ga4BigQueryDataset` são identificadores públicos — quem
  // os tem não consegue ler nada sem a service account. Já `uappiApiKey` e
  // `uappiSecretKey` são segredos, e ficam deliberadamente FORA daqui: o tenant
  // atravessa o canal stdio de todos os MCP servers e entra no hash da chave de
  // cache, então colocar segredo nele os espalharia por processos que não
  // precisam deles. Quem precisa de credencial da Uappi (o sync, em T24; a
  // ferramenta de estoque, em T15) lê e decifra do banco por conta própria.
  const externalIds: Record<string, string> = {};
  if (organization.ga4PropertyId) externalIds.ga4PropertyId = organization.ga4PropertyId;
  if (organization.ga4BigQueryDataset) externalIds.ga4BigQueryDataset = organization.ga4BigQueryDataset;

  return { organizationId: organization.id, externalIds };
}
