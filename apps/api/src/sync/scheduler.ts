import type { PrismaClient } from '@prisma/client';
import type { Pseudonymizer } from '@center/pii';
import type { SecretBox } from '@center/secrets';
import type { UappiClientLike, UappiCredentials } from '@center/uappi-client';
import { runIncrementalSync } from '@center/uappi-sync';
import type { AppConfig } from '../config.js';

export interface SchedulerDeps {
  prisma: PrismaClient;
  config: AppConfig;
  pseudonymizer: Pseudonymizer;
  /** Decifra `uappiApiKey`/`uappiSecretKey`, gravados cifrados pela T24B. */
  secretBox: SecretBox;
  buildClient: (credentials: UappiCredentials) => UappiClientLike;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface SchedulerReport {
  organizations: number;
  succeeded: number;
  failed: number;
}

/**
 * Sincroniza todas as organizações, uma por vez.
 *
 * Sequencial de propósito: cada organização tem sua própria cota na Uappi, mas
 * o banco é compartilhado, e paralelizar aqui trocaria um gargalo previsível
 * por contenção imprevisível. Uma falha nunca interrompe as demais.
 */
export async function syncAllOrganizations(deps: SchedulerDeps): Promise<SchedulerReport> {
  const log = deps.logger ?? (() => {});

  const organizations = await deps.prisma.organization.findMany({
    select: { id: true, uappiApiKey: true, uappiSecretKey: true, statusMapping: true },
  });

  const eligible = organizations.filter((org) => org.uappiApiKey && org.uappiSecretKey);

  let succeeded = 0;
  let failed = 0;

  for (const organization of eligible) {
    try {
      // As duas colunas guardam texto cifrado (T24B) — nunca a credencial em
      // claro. O decrypt acontece aqui, no único ponto que precisa do valor real.
      const client = deps.buildClient({
        apiKey: deps.secretBox.decryptOrNull(organization.uappiApiKey)!,
        secretKey: deps.secretBox.decryptOrNull(organization.uappiSecretKey)!,
      });

      const result = await runIncrementalSync({
        prisma: deps.prisma,
        client,
        pseudonymizer: deps.pseudonymizer,
        organizationId: organization.id,
        statusOverrides: (organization.statusMapping as Record<string, string> | null) ?? null,
        ...(deps.now ? { now: deps.now } : {}),
        logger: log,
      }, { backfillDays: deps.config.syncBackfillDays });

      succeeded += 1;
      log('sync concluído', {
        organizationId: organization.id,
        processed: result.ordersProcessed,
        failedOrders: result.ordersFailed,
      });
    } catch (error) {
      failed += 1;
      log('falha no sync da organização', {
        organizationId: organization.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { organizations: eligible.length, succeeded, failed };
}
