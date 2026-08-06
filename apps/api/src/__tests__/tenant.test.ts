import type { PrismaClient } from '@prisma/client';
import { resolveTenant } from '../tenant.js';

function fakePrisma(organization: unknown): PrismaClient {
  return { organization: { findUnique: jest.fn(async () => organization) } } as unknown as PrismaClient;
}

describe('resolveTenant', () => {
  it('builds externalIds from the organization row', async () => {
    const prisma = fakePrisma({
      id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: 'analytics_111',
    });
    expect(await resolveTenant(prisma, 'org_1')).toEqual({
      organizationId: 'org_1',
      externalIds: { ga4PropertyId: '111', ga4BigQueryDataset: 'analytics_111' },
    });
  });

  it('omits unconfigured external ids instead of sending empty strings', async () => {
    const prisma = fakePrisma({ id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: null });
    expect(await resolveTenant(prisma, 'org_1')).toEqual({
      organizationId: 'org_1', externalIds: { ga4PropertyId: '111' },
    });
  });

  it('never puts Uappi credentials in the tenant', async () => {
    // O tenant atravessa todos os MCP servers e entra no hash da chave de
    // cache. Segredo aqui é segredo espalhado por processo que não precisa dele.
    const prisma = fakePrisma({
      id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: null,
      uappiApiKey: 'v1.deadbeef.cafe.1234', uappiSecretKey: 'v1.feedface.babe.5678',
    });
    const tenant = await resolveTenant(prisma, 'org_1');
    expect(tenant.externalIds).not.toHaveProperty('uappiApiKey');
    expect(tenant.externalIds).not.toHaveProperty('uappiSecretKey');
    expect(JSON.stringify(tenant)).not.toContain('v1.');
  });

  it('does not even select the credential columns from the database', async () => {
    const prisma = fakePrisma({ id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: null });
    await resolveTenant(prisma, 'org_1');
    const select = (prisma.organization.findUnique as jest.Mock).mock.calls[0]![0].select;
    expect(select).not.toHaveProperty('uappiApiKey');
    expect(select).not.toHaveProperty('uappiSecretKey');
  });

  it('throws when the organization does not exist', async () => {
    await expect(resolveTenant(fakePrisma(null), 'org_missing'))
      .rejects.toThrow('organização não encontrada: org_missing');
  });
});
