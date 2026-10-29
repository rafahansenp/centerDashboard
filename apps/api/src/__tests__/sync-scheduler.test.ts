import type { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import type { SecretBox } from '@center/secrets';
import type { CommerceConnector } from '@center/connectors';
import { syncAllOrganizations } from '../sync/scheduler.js';
import { testConfig } from './helpers/config.js';

jest.mock('@center/connectors', () => ({
  runCommerceSync: jest.fn(async () => ({
    ordersProcessed: 3, ordersFailed: 0, from: '2026-07-01', to: '2026-07-20',
  })),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runCommerceSync } = require('@center/connectors') as { runCommerceSync: jest.Mock };

// As credenciais chegam do Postgres CIFRADAS (T24B); o fake abaixo simula o
// decrypt como identidade, então os testes continuam legíveis sem precisar
// gerar texto cifrado real.
function fakeSecretBox(): SecretBox {
  return { decryptOrNull: jest.fn((v: string | null) => v) } as unknown as SecretBox;
}

function buildDeps(organizations: unknown[]) {
  const prisma = {
    organization: { findMany: jest.fn(async () => organizations) },
  } as unknown as PrismaClient;

  return {
    prisma,
    config: testConfig,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox: fakeSecretBox(),
    connector: { provider: 'UAPPI' } as unknown as CommerceConnector,
    logger: jest.fn(),
  };
}

const configured = {
  id: 'org_1', uappiApiKey: 'ak', uappiSecretKey: 'sk', statusMapping: { '7': 'CANCELLED' },
};

beforeEach(() => { runCommerceSync.mockClear(); });

describe('syncAllOrganizations', () => {
  it('syncs every organization with credentials', async () => {
    const deps = buildDeps([configured, { ...configured, id: 'org_2' }]);
    const report = await syncAllOrganizations(deps);
    expect(report).toEqual({ organizations: 2, succeeded: 2, failed: 0 });
    expect(runCommerceSync).toHaveBeenCalledTimes(2);
  });

  it('skips organizations with no Uappi credentials', async () => {
    const deps = buildDeps([configured, { id: 'org_2', uappiApiKey: null, uappiSecretKey: null, statusMapping: null }]);
    const report = await syncAllOrganizations(deps);
    expect(report).toEqual({ organizations: 1, succeeded: 1, failed: 0 });
    expect(runCommerceSync).toHaveBeenCalledTimes(1);
  });

  it('passes the per-store status overrides down to the sync', async () => {
    await syncAllOrganizations(buildDeps([configured]));
    // runCommerceSync(deps, options) recebe dois argumentos posicionais —
    // o segundo carrega { backfillDays } vindo de config.syncBackfillDays.
    expect(runCommerceSync).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        settings: expect.objectContaining({ statusOverrides: { '7': 'CANCELLED' } }),
      }),
      expect.objectContaining({ backfillDays: testConfig.syncBackfillDays }),
    );
  });

  it('keeps syncing the other organizations when one fails', async () => {
    runCommerceSync
      .mockRejectedValueOnce(new Error('Uappi 503'))
      .mockResolvedValueOnce({ ordersProcessed: 1, ordersFailed: 0, from: 'a', to: 'b' });
    const deps = buildDeps([configured, { ...configured, id: 'org_2' }]);
    const report = await syncAllOrganizations(deps);
    expect(report).toEqual({ organizations: 2, succeeded: 1, failed: 1 });
  });

  it('logs the failure with the organization id', async () => {
    runCommerceSync.mockRejectedValueOnce(new Error('Uappi 503'));
    const deps = buildDeps([configured]);
    await syncAllOrganizations(deps);
    expect(deps.logger).toHaveBeenCalledWith(
      expect.stringContaining('falha'),
      expect.objectContaining({ organizationId: 'org_1' }),
    );
  });

  it('decrypts each credential before handing it to the sync', async () => {
    const deps = buildDeps([configured]);
    await syncAllOrganizations(deps);
    expect(deps.secretBox.decryptOrNull).toHaveBeenCalledWith('ak');
    expect(deps.secretBox.decryptOrNull).toHaveBeenCalledWith('sk');
  });

  it('passes per-organization credentials and the shared connector to each run', async () => {
    const deps = buildDeps([configured, { ...configured, id: 'org_2', uappiApiKey: 'ak2' }]);
    await syncAllOrganizations(deps);
    expect(runCommerceSync).toHaveBeenCalledTimes(2);
    expect(runCommerceSync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      connector: deps.connector,
      settings: expect.objectContaining({ credentials: { apiKey: 'ak', secretKey: 'sk' } }),
    }), expect.anything());
    expect(runCommerceSync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      settings: expect.objectContaining({ credentials: { apiKey: 'ak2', secretKey: 'sk' } }),
    }), expect.anything());
  });

  it('reports zero work when there is no organization', async () => {
    expect(await syncAllOrganizations(buildDeps([])))
      .toEqual({ organizations: 0, succeeded: 0, failed: 0 });
  });
});
