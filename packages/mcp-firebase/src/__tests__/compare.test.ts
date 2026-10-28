import { createCompareByVersionTool } from '../compare.js';
import { MockFirebaseClient } from '../mock-client.js';

const tool = createCompareByVersionTool(new MockFirebaseClient());
const tenant = { organizationId: 'org_test', externalIds: { ga4AppPropertyId: '111111111' } };

describe('compare_by_version', () => {
  it('is named compare_by_version', () => {
    expect(tool.name).toBe('compare_by_version');
  });

  it('never reports a share above 1 — the version total is the largest single event, never an unrelated query', async () => {
    const result = await tool.handler({
      tenant, from: '2026-08-01', to: '2026-08-31', versionA: '2.3.1', versionB: '2.4.0',
    }) as { rows: Array<{ shareA: number; shareB: number }> };

    for (const row of result.rows) {
      expect(row.shareA).toBeLessThanOrEqual(1);
      expect(row.shareB).toBeLessThanOrEqual(1);
    }
  });

  it('requires ga4AppPropertyId on the tenant', async () => {
    await expect(tool.handler({
      tenant: { organizationId: 'org_sem_app', externalIds: {} },
      from: '2026-08-01', to: '2026-08-31', versionA: '2.3.1', versionB: '2.4.0',
    })).rejects.toThrow(/ga4AppPropertyId/);
  });
});
