import { createCheckoutFunnelTool } from '../funnel.js';
import type { Ga4ReportParams, Ga4Row } from '../client.js';
import type { Ga4ClientLike } from '../interface.js';

function fakeClient(rows: Ga4Row[]) {
  const runReport = jest.fn(async (_params: Ga4ReportParams) => rows);
  return { client: { runReport } as unknown as Ga4ClientLike, runReport };
}

const tenant = { organizationId: 'org_1', externalIds: { ga4PropertyId: '111' } };
const period = { from: '2026-02-01', to: '2026-02-28', tenant };

function eventRows(counts: Record<string, number>): Ga4Row[] {
  return Object.entries(counts).map(([eventName, activeUsers]) => ({
    dimensions: { eventName }, metrics: { activeUsers, eventCount: activeUsers },
  }));
}

describe('checkout_funnel', () => {
  it('requests active users grouped by event name', async () => {
    const { client, runReport } = fakeClient([]);
    await createCheckoutFunnelTool(client).handler(period);
    expect(runReport.mock.calls[0]![0]).toMatchObject({
      dimensionNames: ['eventName'], metricNames: ['activeUsers', 'eventCount'],
    });
  });

  it('builds the five standard e-commerce steps in order', async () => {
    const { client } = fakeClient(eventRows({
      view_item: 1000, add_to_cart: 400, begin_checkout: 200, add_payment_info: 120, purchase: 100,
    }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { steps: Array<{ key: string; users: number }> };
    expect(result.steps.map((s) => s.key)).toEqual([
      'view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase',
    ]);
    expect(result.steps.map((s) => s.users)).toEqual([1000, 400, 200, 120, 100]);
  });

  it('computes step conversion and drop-off', async () => {
    const { client } = fakeClient(eventRows({
      view_item: 1000, add_to_cart: 400, begin_checkout: 200, add_payment_info: 120, purchase: 100,
    }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { steps: Array<Record<string, number | null>> };
    expect(result.steps[0]?.stepConversion).toBeNull();
    expect(result.steps[0]?.dropOff).toBe(0);
    expect(result.steps[1]?.stepConversion).toBeCloseTo(0.4, 5);
    expect(result.steps[1]?.dropOff).toBe(600);
  });

  it('identifies the step with the largest absolute drop-off', async () => {
    const { client } = fakeClient(eventRows({
      view_item: 1000, add_to_cart: 400, begin_checkout: 200, add_payment_info: 120, purchase: 100,
    }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { worstStepKey: string };
    // A maior perda absoluta é de view_item para add_to_cart: 600 usuários.
    expect(result.worstStepKey).toBe('add_to_cart');
  });

  it('computes the overall conversion from first to last step', async () => {
    const { client } = fakeClient(eventRows({
      view_item: 1000, add_to_cart: 400, begin_checkout: 200, add_payment_info: 120, purchase: 100,
    }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { overallConversion: number };
    expect(result.overallConversion).toBeCloseTo(0.1, 5);
  });

  it('states plainly that it cannot identify individual users', async () => {
    const { client } = fakeClient(eventRows({ view_item: 10, purchase: 1 }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { identifiesUsers: boolean; note: string };
    expect(result.identifiesUsers).toBe(false);
    expect(result.note).toMatch(/não identifica/i);
  });

  it('treats a missing event as zero instead of dropping the step', async () => {
    const { client } = fakeClient(eventRows({ view_item: 500, purchase: 20 }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { steps: Array<{ key: string; users: number }> };
    expect(result.steps).toHaveLength(5);
    expect(result.steps.find((s) => s.key === 'begin_checkout')?.users).toBe(0);
  });

  it('does not divide by zero when the first step has no users', async () => {
    const { client } = fakeClient([]);
    const result = await createCheckoutFunnelTool(client).handler(period) as {
      overallConversion: number; worstStepKey: string | null; steps: Array<{ stepConversion: number | null }>;
    };
    expect(result.overallConversion).toBe(0);
    expect(result.worstStepKey).toBeNull();
    expect(result.steps[1]?.stepConversion).toBe(0);
  });

  it('refuses without a GA4 property id', async () => {
    const { client } = fakeClient([]);
    await expect(createCheckoutFunnelTool(client).handler({
      ...period, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4PropertyId não configurado');
  });
});
