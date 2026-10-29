import type { PrismaClient } from '@prisma/client';
import { MODULE_KEYS, type IntegrationKind } from '@center/entitlements';
import type { SecretBox } from '@center/secrets';
import { slugify } from '../../src/lib/slug.js';

/**
 * Linha das colunas LEGADAS de Organization (removidas na Task 21). Por isso
 * é lida com `$queryRaw` e não pelo client tipado: o script continua
 * compilando depois que as colunas saírem do schema.
 */
export interface LegacyOrgRow {
  id: string;
  name: string;
  slug: string | null;
  uappiApiKey: string | null;
  uappiSecretKey: string | null;
  statusMapping: unknown;
  ga4PropertyId: string | null;
  ga4BigQueryDataset: string | null;
  ga4AppPropertyId: string | null;
  playConsoleCredsJson: string | null;
  appStoreConnectKeyJson: string | null;
  mondayBoardId: string | null;
  /** Só para gerar o aviso; o valor nunca é usado nem registrado. */
  mondayApiToken?: string | null;
}

export interface IntegrationWrite {
  kind: IntegrationKind;
  provider: string;
  config: Record<string, unknown>;
  secrets: string | null;
}

export interface MigrationReport {
  organizations: number;
  integrationsCreated: number;
  integrationsSkipped: number;
  modulesCreated: number;
  grantsCreated: number;
  warnings: string[];
}

/** Decifra um campo legado; devolve null (sem vazar o valor) se não decifrar. */
function tryDecrypt(box: SecretBox, field: string, value: string, warnings: string[], orgId: string): string | null {
  try {
    return box.decrypt(value);
  } catch {
    warnings.push(
      `org ${orgId}: o campo ${field} não pôde ser decifrado (provavelmente gravado em claro) — integração ignorada`,
    );
    return null;
  }
}

export function planIntegrations(
  org: LegacyOrgRow,
  box: SecretBox,
): { writes: IntegrationWrite[]; warnings: string[] } {
  const writes: IntegrationWrite[] = [];
  const warnings: string[] = [];

  if (org.uappiApiKey && org.uappiSecretKey) {
    const apiKey = tryDecrypt(box, 'uappiApiKey', org.uappiApiKey, warnings, org.id);
    const secretKey = tryDecrypt(box, 'uappiSecretKey', org.uappiSecretKey, warnings, org.id);
    if (apiKey !== null && secretKey !== null) {
      const config: Record<string, unknown> = {};
      if (org.statusMapping !== null && org.statusMapping !== undefined) config.statusMapping = org.statusMapping;
      writes.push({
        kind: 'COMMERCE',
        provider: 'UAPPI',
        config,
        secrets: box.encrypt(JSON.stringify({ apiKey, secretKey })),
      });
    }
  }

  if (org.ga4PropertyId) {
    const config: Record<string, unknown> = { propertyId: org.ga4PropertyId };
    if (org.ga4BigQueryDataset) config.bigQueryDataset = org.ga4BigQueryDataset;
    writes.push({ kind: 'WEB_ANALYTICS', provider: 'GA4', config, secrets: null });
  }

  if (org.ga4AppPropertyId) {
    writes.push({ kind: 'APP_ANALYTICS', provider: 'GA4', config: { propertyId: org.ga4AppPropertyId }, secrets: null });
  }

  if (org.playConsoleCredsJson) {
    const credentialsJson = tryDecrypt(box, 'playConsoleCredsJson', org.playConsoleCredsJson, warnings, org.id);
    if (credentialsJson !== null) {
      writes.push({
        kind: 'PLAY_STORE',
        provider: 'GOOGLE_PLAY',
        config: {},
        secrets: box.encrypt(JSON.stringify({ credentialsJson })),
      });
    }
  }

  if (org.appStoreConnectKeyJson) {
    const keyJson = tryDecrypt(box, 'appStoreConnectKeyJson', org.appStoreConnectKeyJson, warnings, org.id);
    if (keyJson !== null) {
      writes.push({
        kind: 'APP_STORE',
        provider: 'APP_STORE_CONNECT',
        config: {},
        secrets: box.encrypt(JSON.stringify({ keyJson })),
      });
    }
  }

  if (org.mondayBoardId) {
    writes.push({ kind: 'SPRINT_BOARD', provider: 'MONDAY', config: { boardId: org.mondayBoardId }, secrets: null });
  }

  if (org.mondayApiToken) {
    warnings.push(`org ${org.id}: o token do Monday agora é global: defina MONDAY_API_TOKEN`);
  }

  return { writes, warnings };
}

/**
 * Migração de dados idempotente para o modelo multi-tenant: preenche slug,
 * módulos, acessos de membros e (enquanto as colunas legadas existirem) as
 * integrações. Nunca altera uma integração que já exista.
 */
export async function migrateToMultiTenant(prisma: PrismaClient, box: SecretBox): Promise<MigrationReport> {
  const report: MigrationReport = {
    organizations: 0,
    integrationsCreated: 0,
    integrationsSkipped: 0,
    modulesCreated: 0,
    grantsCreated: 0,
    warnings: [],
  };

  const columns = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Organization' AND column_name = 'uappiApiKey'`;
  const hasLegacyColumns = columns.length > 0;

  let orgs: LegacyOrgRow[];
  if (hasLegacyColumns) {
    orgs = await prisma.$queryRaw<LegacyOrgRow[]>`
      SELECT "id", "name", "slug", "uappiApiKey", "uappiSecretKey", "statusMapping",
             "ga4PropertyId", "ga4BigQueryDataset", "ga4AppPropertyId",
             "playConsoleCredsJson", "appStoreConnectKeyJson", "mondayBoardId", "mondayApiToken"
      FROM "Organization" ORDER BY "createdAt" ASC`;
  } else {
    const rows = await prisma.organization.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: { createdAt: 'asc' },
    });
    orgs = rows.map((r) => ({
      ...r,
      uappiApiKey: null, uappiSecretKey: null, statusMapping: null, ga4PropertyId: null,
      ga4BigQueryDataset: null, ga4AppPropertyId: null, playConsoleCredsJson: null,
      appStoreConnectKeyJson: null, mondayBoardId: null,
    }));
  }

  const taken = new Set(orgs.map((o) => o.slug).filter((s): s is string => !!s));

  for (const org of orgs) {
    report.organizations += 1;

    // Slug: só quando nulo; colisão acrescenta -2, -3...
    if (!org.slug) {
      const base = slugify(org.name);
      let candidate = base;
      for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
      taken.add(candidate);
      await prisma.organization.update({ where: { id: org.id }, data: { slug: candidate } });
    }

    if (hasLegacyColumns) {
      const { writes, warnings } = planIntegrations(org, box);
      report.warnings.push(...warnings);
      const existing = await prisma.integration.findMany({
        where: { organizationId: org.id },
        select: { kind: true },
      });
      const existingKinds = new Set<string>(existing.map((e) => e.kind));
      for (const write of writes) {
        if (existingKinds.has(write.kind)) {
          report.integrationsSkipped += 1;
          continue;
        }
        await prisma.integration.create({
          data: {
            organizationId: org.id,
            kind: write.kind,
            provider: write.provider as never,
            config: write.config as never,
            secrets: write.secrets,
            secretsUpdatedAt: write.secrets ? new Date() : null,
            status: 'OK',
          },
        });
        report.integrationsCreated += 1;
      }
    }

    const modules = await prisma.organizationModule.createMany({
      data: MODULE_KEYS.map((moduleKey) => ({ organizationId: org.id, moduleKey, origin: 'MANUAL' as const })),
      skipDuplicates: true,
    });
    report.modulesCreated += modules.count;

    const members = await prisma.user.findMany({
      where: { organizationId: org.id, role: 'MEMBER' },
      select: { id: true },
    });
    for (const member of members) {
      const grants = await prisma.userModuleAccess.createMany({
        data: MODULE_KEYS.map((moduleKey) => ({ userId: member.id, moduleKey })),
        skipDuplicates: true,
      });
      report.grantsCreated += grants.count;
    }
  }

  return report;
}
