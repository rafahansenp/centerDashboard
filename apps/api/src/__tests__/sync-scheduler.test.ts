import type { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import type { SecretBox } from '@center/secrets';
import type { ConnectorRegistry } from '@center/connectors';
import { syncAllOrganizations } from '../sync/scheduler.js';
import { testConfig } from './helpers/config.js';

jest.mock('@center/connectors', () => ({
  runCommerceSync: jest.fn(async () => ({
    ordersProcessed: 3, ordersFailed: 0, from: '2026-07-01', to: '2026-07-20',
  })),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runCommerceSync } = require('@center/connectors') as { runCommerceSync: jest.Mock };

// Os segredos chegam do Postgres como um único JSON cifrado; o fake abaixo
// simula o decrypt como identidade, então o "texto cifrado" já é o JSON.
function fakeSecretBox(): SecretBox {
  return { decrypt: jest.fn((v: string) => v) } as unknown as SecretBox;
}

const parseSettings = jest.fn((config: unknown, secrets: unknown) => ({
  credentials: secrets, statusOverrides: (config as { statusMapping?: unknown }).statusMapping ?? null,
}));
const connector = { provider: 'UAPPI', parseSettings };

function buildDeps(integrations: unknown[]) {
  const update = jest.fn(async () => ({}));
  const findMany = jest.fn(async () => integrations);
  const prisma = { integration: { findMany, update } } as unknown as PrismaClient;
  return {
    update,
    findMany,
    deps: {
      prisma,
      config: testConfig,
      pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
      secretBox: fakeSecretBox(),
      connectors: { get: jest.fn(() => connector) } as unknown as ConnectorRegistry,
      logger: jest.fn(),
      now: () => new Date('2026-07-20T12:00:00Z'),
    },
  };
}

const row = (organizationId: string, extra: Record<string, unknown> = {}) => ({
  id: `int_${organizationId}`,
  organizationId,
  provider: 'UAPPI',
  status: 'OK',
  config: { statusMapping: { '7': 'CANCELLED' } },
  secrets: JSON.stringify({ apiKey: 'ak', secretKey: 'sk' }),
  ...extra,
});

beforeEach(() => { runCommerceSync.mockClear(); parseSettings.mockClear(); });

describe('syncAllOrganizations', () => {
  it('syncs every eligible COMMERCE integration', async () => {
    const { deps } = buildDeps([row('org_1'), row('org_2')]);
    expect(await syncAllOrganizations(deps)).toEqual({ organizations: 2, succeeded: 2, failed: 0 });
    expect(runCommerceSync).toHaveBeenCalledTimes(2);
  });

  it('skips suspended organizations', async () => {
    const { deps, findMany } = buildDeps([]);
    await syncAllOrganizations(deps);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organization: { status: 'ACTIVE' } }),
    }));
  });

  it('skips DISABLED integrations', async () => {
    const { deps, findMany } = buildDeps([]);
    await syncAllOrganizations(deps);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        kind: 'COMMERCE',
        status: { not: 'DISABLED' },
        secrets: { not: null },
      }),
    }));
  });

  it('passes parsed settings, organization id and backfill window to the sync', async () => {
    const { deps } = buildDeps([row('org_1')]);
    await syncAllOrganizations(deps);
    expect(parseSettings).toHaveBeenCalledWith(
      { statusMapping: { '7': 'CANCELLED' } },
      { apiKey: 'ak', secretKey: 'sk' },
    );
    expect(runCommerceSync).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        connector,
        settings: expect.objectContaining({ statusOverrides: { '7': 'CANCELLED' } }),
      }),
      expect.objectContaining({ backfillDays: testConfig.syncBackfillDays }),
    );
  });

  it('one failing organization does not stop the next', async () => {
    runCommerceSync
      .mockRejectedValueOnce(new Error('Uappi 503'))
      .mockResolvedValueOnce({ ordersProcessed: 1, ordersFailed: 0, from: 'a', to: 'b' });
    const { deps, update } = buildDeps([row('org_1'), row('org_2')]);
    expect(await syncAllOrganizations(deps)).toEqual({ organizations: 2, succeeded: 1, failed: 1 });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'int_org_1' },
      data: expect.objectContaining({ status: 'ERROR', lastError: 'Uappi 503' }),
    });
  });

  it('logs the failure with the organization id', async () => {
    runCommerceSync.mockRejectedValueOnce(new Error('Uappi 503'));
    const { deps } = buildDeps([row('org_1')]);
    await syncAllOrganizations(deps);
    expect(deps.logger).toHaveBeenCalledWith(
      expect.stringContaining('falha'),
      expect.objectContaining({ organizationId: 'org_1' }),
    );
  });

  it('marks ERROR with "configuração inválida" when parseSettings throws', async () => {
    parseSettings.mockImplementationOnce(() => { throw new Error('zod'); });
    const { deps, update } = buildDeps([row('org_1'), row('org_2')]);
    expect(await syncAllOrganizations(deps)).toEqual({ organizations: 2, succeeded: 1, failed: 1 });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'int_org_1' },
      data: expect.objectContaining({ status: 'ERROR', lastError: 'configuração inválida' }),
    });
    expect(runCommerceSync).toHaveBeenCalledTimes(1);
  });

  it('promotes PENDING to OK after a successful run', async () => {
    const { deps, update } = buildDeps([row('org_1', { status: 'PENDING' })]);
    await syncAllOrganizations(deps);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'int_org_1' },
      data: expect.objectContaining({ status: 'OK', lastError: null }),
    });
  });

  it('an unknown provider fails that integration and the next one still syncs', async () => {
    const { deps } = buildDeps([row('org_1', { provider: 'NOPE' }), row('org_2')]);
    (deps.connectors.get as jest.Mock).mockImplementationOnce(() => { throw new Error('provedor desconhecido'); });
    expect(await syncAllOrganizations(deps)).toEqual({ organizations: 2, succeeded: 1, failed: 1 });
    expect(runCommerceSync).toHaveBeenCalledTimes(1);
    expect(runCommerceSync).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_2' }), expect.anything(),
    );
  });

  it('a failing status write in the error path does not stop the next organization', async () => {
    runCommerceSync.mockRejectedValueOnce(new Error('Uappi 503'));
    const { deps, update } = buildDeps([row('org_1'), row('org_2')]);
    update.mockRejectedValueOnce(new Error('db down'));
    expect(await syncAllOrganizations(deps)).toEqual({ organizations: 2, succeeded: 1, failed: 1 });
    expect(runCommerceSync).toHaveBeenCalledTimes(2);
  });

  it('a failing OK promotion after a successful sync counts once as succeeded', async () => {
    const { deps, update } = buildDeps([row('org_1', { status: 'PENDING' }), row('org_2')]);
    update.mockRejectedValueOnce(new Error('db down'));
    expect(await syncAllOrganizations(deps)).toEqual({ organizations: 2, succeeded: 2, failed: 0 });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite the status when it was already OK', async () => {
    const { deps, update } = buildDeps([row('org_1')]);
    await syncAllOrganizations(deps);
    expect(update).not.toHaveBeenCalled();
  });

  it('reports zero work when there is no integration', async () => {
    expect(await syncAllOrganizations(buildDeps([]).deps))
      .toEqual({ organizations: 0, succeeded: 0, failed: 0 });
  });
});
