import { SecretBox } from '@center/secrets';
import { MODULE_KEYS } from '@center/entitlements';
import {
  planIntegrations,
  migrateToMultiTenant,
  type LegacyOrgRow,
} from '../lib/migrate-to-multitenant.js';

const box = new SecretBox('07'.repeat(32));

const emptyOrg: LegacyOrgRow = {
  id: 'org_1', name: 'Loja Teste', slug: null,
  uappiApiKey: null, uappiSecretKey: null, statusMapping: null,
  ga4PropertyId: null, ga4BigQueryDataset: null, ga4AppPropertyId: null,
  playConsoleCredsJson: null, appStoreConnectKeyJson: null, mondayBoardId: null,
};

describe('planIntegrations', () => {
  it('plans a COMMERCE integration with both secrets in one encrypted JSON', () => {
    const { writes } = planIntegrations(
      { ...emptyOrg, uappiApiKey: box.encrypt('k'), uappiSecretKey: box.encrypt('s') },
      box,
    );
    const write = writes.find((w) => w.kind === 'COMMERCE')!;
    expect(write.provider).toBe('UAPPI');
    expect(JSON.parse(box.decrypt(write.secrets!))).toEqual({ apiKey: 'k', secretKey: 's' });
  });

  it('skips commerce when only one Uappi key is set', () => {
    const { writes } = planIntegrations({ ...emptyOrg, uappiApiKey: box.encrypt('k') }, box);
    expect(writes.find((w) => w.kind === 'COMMERCE')).toBeUndefined();
  });

  it('warns about the Monday token without leaking it', () => {
    const { warnings } = planIntegrations(
      { ...emptyOrg, mondayBoardId: '123', mondayApiToken: 'super-secret-token' } as LegacyOrgRow,
      box,
    );
    expect(warnings.some((w) => /MONDAY_API_TOKEN/.test(w))).toBe(true);
    expect(warnings.join(' ')).not.toContain('super-secret-token');
  });

  it('warns and skips a field that does not decrypt', () => {
    const { writes, warnings } = planIntegrations(
      { ...emptyOrg, playConsoleCredsJson: 'plain-text-not-encrypted' },
      box,
    );
    expect(writes.find((w) => w.kind === 'PLAY_STORE')).toBeUndefined();
    expect(warnings.some((w) => w.includes('playConsoleCredsJson'))).toBe(true);
    expect(warnings.join(' ')).not.toContain('plain-text-not-encrypted');
  });

  it('maps GA4, app GA4, Monday and store fields', () => {
    const { writes } = planIntegrations(
      {
        ...emptyOrg,
        ga4PropertyId: 'p1', ga4BigQueryDataset: 'ds', ga4AppPropertyId: 'p2', mondayBoardId: 'b1',
        appStoreConnectKeyJson: box.encrypt('{"a":1}'),
      },
      box,
    );
    expect(writes.find((w) => w.kind === 'WEB_ANALYTICS')!.config).toEqual({ propertyId: 'p1', bigQueryDataset: 'ds' });
    expect(writes.find((w) => w.kind === 'APP_ANALYTICS')!.config).toEqual({ propertyId: 'p2' });
    expect(writes.find((w) => w.kind === 'SPRINT_BOARD')!.config).toEqual({ boardId: 'b1' });
    const store = writes.find((w) => w.kind === 'APP_STORE')!;
    expect(JSON.parse(box.decrypt(store.secrets!))).toEqual({ keyJson: '{"a":1}' });
  });
});

type Row = Record<string, unknown>;

function fakePrisma(opts: { legacyColumns: boolean; org?: Partial<LegacyOrgRow>; existing?: Row[] }) {
  const integrations: Row[] = [...(opts.existing ?? [])];
  const org = { ...emptyOrg, ...opts.org };
  const prisma = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('information_schema')) return opts.legacyColumns ? [{ column_name: 'uappiApiKey' }] : [];
      return [org];
    }),
    organization: {
      findMany: jest.fn(async () => [{ id: 'org_1', name: 'Loja Teste', slug: null }]),
      update: jest.fn(async () => ({})),
    },
    integration: {
      findMany: jest.fn(async () => integrations.map((i) => ({ kind: i.kind }))),
      create: jest.fn(async ({ data }: { data: Row }) => { integrations.push(data); return data; }),
    },
    organizationModule: { createMany: jest.fn(async () => ({ count: MODULE_KEYS.length })) },
    user: { findMany: jest.fn(async () => [{ id: 'u1' }]) },
    userModuleAccess: { createMany: jest.fn(async () => ({ count: MODULE_KEYS.length })) },
  };
  return prisma;
}

const commerceOrg = () => ({ uappiApiKey: box.encrypt('k'), uappiSecretKey: box.encrypt('s') });

describe('migrateToMultiTenant', () => {
  it('does not overwrite an existing integration', async () => {
    const prisma = fakePrisma({ legacyColumns: true, org: commerceOrg(), existing: [{ kind: 'COMMERCE' }] });
    const report = await migrateToMultiTenant(prisma as never, box);
    expect(prisma.integration.create).not.toHaveBeenCalled();
    expect(report.integrationsSkipped).toBe(1);
  });

  it('is idempotent', async () => {
    const prisma = fakePrisma({ legacyColumns: true, org: commerceOrg() });
    const first = await migrateToMultiTenant(prisma as never, box);
    expect(first.integrationsCreated).toBe(1);
    const second = await migrateToMultiTenant(prisma as never, box);
    expect(second.integrationsCreated).toBe(0);
  });

  it('creates migrated integrations with status OK, modules and member grants', async () => {
    const prisma = fakePrisma({ legacyColumns: true, org: commerceOrg() });
    await migrateToMultiTenant(prisma as never, box);
    expect(prisma.integration.create.mock.calls[0][0].data.status).toBe('OK');
    expect(prisma.organizationModule.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.userModuleAccess.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it('skips integration planning when legacy columns are gone', async () => {
    const prisma = fakePrisma({ legacyColumns: false });
    const report = await migrateToMultiTenant(prisma as never, box);
    expect(prisma.integration.create).not.toHaveBeenCalled();
    expect(prisma.organizationModule.createMany).toHaveBeenCalled();
    expect(prisma.userModuleAccess.createMany).toHaveBeenCalled();
    expect(report.integrationsCreated).toBe(0);
  });
});
