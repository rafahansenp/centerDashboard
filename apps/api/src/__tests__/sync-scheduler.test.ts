import type { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import type { SecretBox } from '@center/secrets';
import type { UappiClientLike } from '@center/uappi-client';
import { syncAllOrganizations } from '../sync/scheduler.js';
import { testConfig } from './helpers/config.js';

jest.mock('@center/uappi-sync', () => ({
  runIncrementalSync: jest.fn(async () => ({
    ordersProcessed: 3, ordersFailed: 0, from: '2026-07-01', to: '2026-07-20',
  })),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runIncrementalSync } = require('@center/uappi-sync') as { runIncrementalSync: jest.Mock };

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
    buildClient: jest.fn(() => ({}) as UappiClientLike),
    logger: jest.fn(),
  };
}

const configured = {
  id: 'org_1', uappiApiKey: 'ak', uappiSecretKey: 'sk', statusMapping: { '7': 'CANCELLED' },
};

beforeEach(() => { runIncrementalSync.mockClear(); });

describe('syncAllOrganizations', () => {
  it('syncs every organization with credentials', async () => {
    const deps = buildDeps([configured, { ...configured, id: 'org_2' }]);
    const report = await syncAllOrganizations(deps);
    expect(report).toEqual({ organizations: 2, succeeded: 2, failed: 0 });
    expect(runIncrementalSync).toHaveBeenCalledTimes(2);
  });

  it('skips organizations with no Uappi credentials', async () => {
    const deps = buildDeps([configured, { id: 'org_2', uappiApiKey: null, uappiSecretKey: null, statusMapping: null }]);
    const report = await syncAllOrganizations(deps);
    expect(report).toEqual({ organizations: 1, succeeded: 1, failed: 0 });
    expect(runIncrementalSync).toHaveBeenCalledTimes(1);
  });

  it('passes the per-store status overrides down to the sync', async () => {
    await syncAllOrganizations(buildDeps([configured]));
    // runIncrementalSync(deps, options) recebe dois argumentos posicionais —
    // o segundo carrega { backfillDays } vindo de config.syncBackfillDays.
    expect(runIncrementalSync).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1', statusOverrides: { '7': 'CANCELLED' } }),
      expect.objectContaining({ backfillDays: testConfig.syncBackfillDays }),
    );
  });

  it('keeps syncing the other organizations when one fails', async () => {
    runIncrementalSync
      .mockRejectedValueOnce(new Error('Uappi 503'))
      .mockResolvedValueOnce({ ordersProcessed: 1, ordersFailed: 0, from: 'a', to: 'b' });
    const deps = buildDeps([configured, { ...configured, id: 'org_2' }]);
    const report = await syncAllOrganizations(deps);
    expect(report).toEqual({ organizations: 2, succeeded: 1, failed: 1 });
  });

  it('logs the failure with the organization id', async () => {
    runIncrementalSync.mockRejectedValueOnce(new Error('Uappi 503'));
    const deps = buildDeps([configured]);
    await syncAllOrganizations(deps);
    expect(deps.logger).toHaveBeenCalledWith(
      expect.stringContaining('falha'),
      expect.objectContaining({ organizationId: 'org_1' }),
    );
  });

  it('decrypts each credential before building the client', async () => {
    const deps = buildDeps([configured]);
    await syncAllOrganizations(deps);
    expect(deps.secretBox.decryptOrNull).toHaveBeenCalledWith('ak');
    expect(deps.secretBox.decryptOrNull).toHaveBeenCalledWith('sk');
  });

  it('builds one Uappi client per organization, never shared', async () => {
    const deps = buildDeps([configured, { ...configured, id: 'org_2', uappiApiKey: 'ak2' }]);
    await syncAllOrganizations(deps);
    expect(deps.buildClient).toHaveBeenCalledTimes(2);
    expect(deps.buildClient).toHaveBeenNthCalledWith(1, { apiKey: 'ak', secretKey: 'sk' });
    expect(deps.buildClient).toHaveBeenNthCalledWith(2, { apiKey: 'ak2', secretKey: 'sk' });
  });

  it('reports zero work when there is no organization', async () => {
    expect(await syncAllOrganizations(buildDeps([])))
      .toEqual({ organizations: 0, succeeded: 0, failed: 0 });
  });
});
