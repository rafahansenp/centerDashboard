import type { PrismaClient } from '@prisma/client';
import type { TenantContext } from '@center/shared';

/**
 * Traduz as integrações da Organization no TenantContext que os MCP servers
 * consomem. Ids não configurados são omitidos — assim o provider falha com
 * "X não configurado" em vez de mandar string vazia para a API externa.
 */
export async function resolveTenant(
  prisma: PrismaClient,
  organizationId: string,
): Promise<TenantContext> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true },
  });
  if (!organization) throw new Error(`organização não encontrada: ${organizationId}`);

  // SÓ IDENTIFICADORES, NUNCA CREDENCIAIS.
  //
  // `propertyId` e `bigQueryDataset` são identificadores públicos — quem os tem
  // não consegue ler nada sem a service account. `Integration.secrets` fica
  // deliberadamente FORA (nem é selecionado): o tenant atravessa o canal stdio
  // de todos os MCP servers e entra no hash da chave de cache, então colocar
  // segredo nele os espalharia por processos que não precisam deles. Quem
  // precisa de credencial lê e decifra do banco por conta própria.
  const integrations = await prisma.integration.findMany({
    where: {
      organizationId,
      kind: { in: ['WEB_ANALYTICS', 'APP_ANALYTICS'] },
      status: { not: 'DISABLED' },
    },
    select: { kind: true, status: true, config: true },
  });

  const externalIds: Record<string, string> = {};
  for (const integration of integrations) {
    if (integration.status === 'DISABLED') continue;
    const config = (integration.config ?? {}) as Record<string, unknown>;
    const propertyId = typeof config.propertyId === 'string' ? config.propertyId : '';
    if (integration.kind === 'WEB_ANALYTICS') {
      if (propertyId) externalIds.ga4PropertyId = propertyId;
      if (typeof config.bigQueryDataset === 'string' && config.bigQueryDataset) {
        externalIds.ga4BigQueryDataset = config.bigQueryDataset;
      }
    } else if (integration.kind === 'APP_ANALYTICS' && propertyId) {
      externalIds.ga4AppPropertyId = propertyId;
    }
  }

  return { organizationId: organization.id, externalIds };
}
