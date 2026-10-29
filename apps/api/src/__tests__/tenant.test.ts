import type { PrismaClient } from '@prisma/client';
import { resolveTenant } from '../tenant.js';

function fakePrisma(organization: unknown, integrations: unknown[] = []): PrismaClient {
  return {
    organization: { findUnique: jest.fn(async () => organization) },
    integration: { findMany: jest.fn(async () => integrations) },
  } as unknown as PrismaClient;
}

describe('resolveTenant', () => {
  it('reads GA4 ids from integrations', async () => {
    const prisma = fakePrisma({ id: 'org_1' }, [
      { kind: 'WEB_ANALYTICS', status: 'OK', config: { propertyId: '111', bigQueryDataset: 'analytics_111' } },
      { kind: 'APP_ANALYTICS', status: 'PENDING', config: { propertyId: '222' } },
    ]);
    expect(await resolveTenant(prisma, 'org_1')).toEqual({
      organizationId: 'org_1',
      externalIds: { ga4PropertyId: '111', ga4BigQueryDataset: 'analytics_111', ga4AppPropertyId: '222' },
    });
  });

  it('omits a DISABLED integration', async () => {
    const prisma = fakePrisma({ id: 'org_1' }, [
      { kind: 'WEB_ANALYTICS', status: 'DISABLED', config: { propertyId: '111' } },
      { kind: 'APP_ANALYTICS', status: 'OK', config: { propertyId: '222' } },
    ]);
    expect(await resolveTenant(prisma, 'org_1')).toEqual({
      organizationId: 'org_1', externalIds: { ga4AppPropertyId: '222' },
    });
  });

  it('never includes secrets', async () => {
    const prisma = fakePrisma({ id: 'org_1' }, [
      { kind: 'WEB_ANALYTICS', status: 'OK', config: { propertyId: '111' }, secrets: 'v1:deadbeef' },
    ]);
    const tenant = await resolveTenant(prisma, 'org_1');
    expect(JSON.stringify(tenant)).not.toContain('v1:');
    const select = (prisma.integration.findMany as jest.Mock).mock.calls[0]![0].select;
    expect(select).not.toHaveProperty('secrets');
  });

  it('throws when the organization does not exist', async () => {
    await expect(resolveTenant(fakePrisma(null), 'org_missing'))
      .rejects.toThrow('organização não encontrada: org_missing');
  });
});
