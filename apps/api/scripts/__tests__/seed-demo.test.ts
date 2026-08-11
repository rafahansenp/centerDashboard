import {
  SeedDemoRefusedError,
  assertMockMode,
  shouldSetUappiCredentials,
  shouldSetField,
  planIntegrationWrite,
  buildAttributionTouchData,
  formatCents,
  formatDateOnly,
  DEMO_UAPPI_API_KEY,
  DEMO_UAPPI_SECRET_KEY,
  DEMO_GA4_PROPERTY_ID,
  DEMO_GA4_BIGQUERY_DATASET,
  TOUCH_LEAD_MINUTES,
  type OrgIntegrationColumns,
  type OrderForTouch,
} from '../lib/seed-demo.js';

describe('assertMockMode', () => {
  it('does nothing when mock mode is on', () => {
    expect(() => assertMockMode(true)).not.toThrow();
  });

  it('refuses with a named error when mock mode is off', () => {
    expect(() => assertMockMode(false)).toThrow(SeedDemoRefusedError);
    expect(() => assertMockMode(false)).toThrow(/MOCK_EXTERNAL_APIS/);
  });
});

describe('shouldSetUappiCredentials', () => {
  it('is true when both credentials are null', () => {
    expect(shouldSetUappiCredentials({ uappiApiKey: null, uappiSecretKey: null })).toBe(true);
  });

  it('is false when only the api key is already set', () => {
    expect(shouldSetUappiCredentials({ uappiApiKey: 'v1.a.b.c', uappiSecretKey: null })).toBe(false);
  });

  it('is false when only the secret key is already set', () => {
    expect(shouldSetUappiCredentials({ uappiApiKey: null, uappiSecretKey: 'v1.a.b.c' })).toBe(false);
  });

  it('is false when both are already set', () => {
    expect(shouldSetUappiCredentials({ uappiApiKey: 'v1.a.b.c', uappiSecretKey: 'v1.d.e.f' })).toBe(false);
  });
});

describe('shouldSetField', () => {
  it('is true only for null', () => {
    expect(shouldSetField(null)).toBe(true);
    expect(shouldSetField('000000000')).toBe(false);
    expect(shouldSetField('a-real-property-id')).toBe(false);
  });
});

describe('planIntegrationWrite', () => {
  const empty: OrgIntegrationColumns = {
    uappiApiKey: null, uappiSecretKey: null, ga4PropertyId: null, ga4BigQueryDataset: null,
  };

  it('plans to write every field on a fresh organization', () => {
    const encrypt = jest.fn((plaintext: string) => `encrypted(${plaintext})`);
    const plan = planIntegrationWrite(empty, encrypt);

    expect(plan.data).toEqual({
      uappiApiKey: `encrypted(${DEMO_UAPPI_API_KEY})`,
      uappiSecretKey: `encrypted(${DEMO_UAPPI_SECRET_KEY})`,
      ga4PropertyId: DEMO_GA4_PROPERTY_ID,
      ga4BigQueryDataset: DEMO_GA4_BIGQUERY_DATASET,
    });
    expect(encrypt).toHaveBeenCalledWith(DEMO_UAPPI_API_KEY);
    expect(encrypt).toHaveBeenCalledWith(DEMO_UAPPI_SECRET_KEY);
  });

  it('never overwrites existing Uappi credentials — the core safety guarantee', () => {
    const encrypt = jest.fn((plaintext: string) => `encrypted(${plaintext})`);
    const org: OrgIntegrationColumns = {
      ...empty, uappiApiKey: 'v1.real.real.real', uappiSecretKey: 'v1.real2.real2.real2',
    };
    const plan = planIntegrationWrite(org, encrypt);

    expect(plan.data).not.toHaveProperty('uappiApiKey');
    expect(plan.data).not.toHaveProperty('uappiSecretKey');
    expect(encrypt).not.toHaveBeenCalled();
    expect(plan.notes.some((n) => /já configuradas/.test(n))).toBe(true);
  });

  it('never overwrites an existing ga4PropertyId', () => {
    const org: OrgIntegrationColumns = { ...empty, ga4PropertyId: 'real-property-123' };
    const plan = planIntegrationWrite(org, (v) => v);
    expect(plan.data).not.toHaveProperty('ga4PropertyId');
  });

  it('never overwrites an existing ga4BigQueryDataset', () => {
    const org: OrgIntegrationColumns = { ...empty, ga4BigQueryDataset: 'real_dataset' };
    const plan = planIntegrationWrite(org, (v) => v);
    expect(plan.data).not.toHaveProperty('ga4BigQueryDataset');
  });

  it('plans nothing at all when the organization is already fully configured', () => {
    const org: OrgIntegrationColumns = {
      uappiApiKey: 'v1.a.b.c', uappiSecretKey: 'v1.d.e.f',
      ga4PropertyId: 'real-property-123', ga4BigQueryDataset: 'real_dataset',
    };
    const plan = planIntegrationWrite(org, (v) => v);
    expect(plan.data).toEqual({});
    expect(plan.notes).toHaveLength(3);
  });
});

describe('buildAttributionTouchData', () => {
  const order: OrderForTouch = {
    visitorHash: 'a1b2c3d4e5f6',
    attributionSource: 'google',
    attributionMedium: 'cpc',
    attributionCampaign: 'black-friday',
    attributionDevice: 'mobile',
    emittedAt: new Date('2026-07-01T13:15:00.000Z'),
  };

  it('copies attribution fields straight from the already-synced order, never inventing PII', () => {
    const touch = buildAttributionTouchData('org_1', order);
    expect(touch).toEqual({
      organizationId: 'org_1',
      visitorHash: order.visitorHash,
      emailHash: null,
      source: 'google',
      medium: 'cpc',
      campaign: 'black-friday',
      device: 'mobile',
      landingPage: null,
      occurredAt: new Date(order.emittedAt.getTime() - TOUCH_LEAD_MINUTES * 60_000),
    });
  });

  it('never carries a raw identifier — only the already-hashed visitorHash', () => {
    const touch = buildAttributionTouchData('org_1', order);
    const serialized = JSON.stringify(touch);
    // Nenhuma chave de client id/e-mail bruto — só o hash já calculado pelo sync real.
    expect(touch).not.toHaveProperty('clientId');
    expect(touch).not.toHaveProperty('email');
    expect(serialized).not.toContain('client_id');
  });

  it('is deterministic — the same order always produces the same occurredAt (backs idempotency)', () => {
    const first = buildAttributionTouchData('org_1', order);
    const second = buildAttributionTouchData('org_1', order);
    expect(first.occurredAt.getTime()).toBe(second.occurredAt.getTime());
    expect(first).toEqual(second);
  });

  it('places the touch strictly before the order it led to', () => {
    const touch = buildAttributionTouchData('org_1', order);
    expect(touch.occurredAt.getTime()).toBeLessThan(order.emittedAt.getTime());
  });
});

describe('formatCents', () => {
  it('formats cents as a pt-BR decimal string', () => {
    expect(formatCents(394710)).toBe('3.947,10');
    expect(formatCents(0)).toBe('0,00');
    expect(formatCents(100)).toBe('1,00');
  });
});

describe('formatDateOnly', () => {
  it('formats a Date as YYYY-MM-DD', () => {
    expect(formatDateOnly(new Date('2026-07-20T17:00:00.000Z'))).toBe('2026-07-20');
  });
});
