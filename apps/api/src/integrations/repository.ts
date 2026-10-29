import type { PrismaClient } from '@prisma/client';
import type { IntegrationState } from '@center/entitlements';
import type { SecretBox } from '@center/secrets';

/** Estado das integrações da organização, no formato que o `@center/entitlements` consome. */
export async function loadIntegrationStates(
  prisma: PrismaClient,
  organizationId: string,
): Promise<IntegrationState[]> {
  const rows = await prisma.integration.findMany({
    where: { organizationId },
    select: { kind: true, status: true, config: true },
  });
  return rows.map((row) => {
    const config = (row.config ?? {}) as Record<string, unknown>;
    return {
      kind: row.kind,
      status: row.status,
      hasBigQueryDataset: typeof config.bigQueryDataset === 'string' && config.bigQueryDataset.length > 0,
    };
  });
}

export function encryptSecrets(box: SecretBox, value: Record<string, unknown>): string {
  return box.encrypt(JSON.stringify(value));
}

export function decryptSecrets(box: SecretBox, ciphertext: string | null): Record<string, unknown> | null {
  if (!ciphertext) return null;
  return JSON.parse(box.decrypt(ciphertext)) as Record<string, unknown>;
}
