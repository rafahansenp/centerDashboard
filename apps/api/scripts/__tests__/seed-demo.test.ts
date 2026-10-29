import {
  SeedDemoRefusedError,
  assertMockMode,
  planDemoIntegrations,
  buildAttributionTouchData,
  formatCents,
  formatDateOnly,
  DEMO_UAPPI_API_KEY,
  DEMO_UAPPI_SECRET_KEY,
  DEMO_GA4_PROPERTY_ID,
  DEMO_GA4_BIGQUERY_DATASET,
  DEMO_GA4_APP_PROPERTY_ID,
  DEMO_MONDAY_BOARD_ID,
  TOUCH_LEAD_MINUTES,
  type OrderForTouch,
} from '../lib/seed-demo.js';

import { SecretBox } from '@center/secrets';
import type { IntegrationKind } from '@center/entitlements';
import { decryptSecrets } from '../../src/integrations/repository.js';

describe('assertMockMode', () => {
  it('does nothing when mock mode is on', () => {
    expect(() => assertMockMode(true)).not.toThrow();
  });

  it('refuses with a named error when mock mode is off', () => {
    expect(() => assertMockMode(false)).toThrow(SeedDemoRefusedError);
    expect(() => assertMockMode(false)).toThrow(/MOCK_EXTERNAL_APIS/);
  });
});

describe('planDemoIntegrations', () => {
  const box = new SecretBox('a'.repeat(64));

  it('plans all six kinds when nothing exists', () => {
    const plan = planDemoIntegrations([], box);
    expect(plan.map((w) => w.kind).sort()).toEqual([
      'APP_ANALYTICS', 'APP_STORE', 'COMMERCE', 'PLAY_STORE', 'SPRINT_BOARD', 'WEB_ANALYTICS',
    ]);
    const byKind = Object.fromEntries(plan.map((w) => [w.kind, w]));
    expect(byKind.WEB_ANALYTICS?.config).toEqual({
      propertyId: DEMO_GA4_PROPERTY_ID, bigQueryDataset: DEMO_GA4_BIGQUERY_DATASET,
    });
    expect(byKind.APP_ANALYTICS?.config).toEqual({ propertyId: DEMO_GA4_APP_PROPERTY_ID });
    expect(byKind.PLAY_STORE?.config).toEqual({ packageName: 'com.demo.loja' });
    expect(byKind.APP_STORE?.config).toEqual({ appId: 'demo-app' });
    expect(byKind.SPRINT_BOARD?.config).toEqual({ boardId: DEMO_MONDAY_BOARD_ID });
  });

  it('never re-plans an existing kind', () => {
    const plan = planDemoIntegrations([{ kind: 'COMMERCE' }, { kind: 'SPRINT_BOARD' }], box);
    expect(plan.map((w) => w.kind)).not.toContain('COMMERCE');
    expect(plan.map((w) => w.kind)).not.toContain('SPRINT_BOARD');
    expect(plan).toHaveLength(4);
    expect(planDemoIntegrations(
      ['COMMERCE', 'WEB_ANALYTICS', 'APP_ANALYTICS', 'PLAY_STORE', 'APP_STORE', 'SPRINT_BOARD']
        .map((kind) => ({ kind: kind as IntegrationKind })), box,
    )).toEqual([]);
  });

  it('commerce secrets decrypt to the demo keys', () => {
    const commerce = planDemoIntegrations([], box).find((w) => w.kind === 'COMMERCE')!;
    expect(commerce.provider).toBe('UAPPI');
    expect(decryptSecrets(box, commerce.secrets)).toEqual({
      apiKey: DEMO_UAPPI_API_KEY, secretKey: DEMO_UAPPI_SECRET_KEY,
    });
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
