import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

function modelBody(name: string): string {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
}

describe('prisma schema invariants', () => {
  it('keeps the order natural key unique per organization', () => {
    expect(modelBody('CommerceOrder')).toMatch(/@@unique\(\[organizationId, numeroPedido\]\)/);
  });

  it('keeps the customer natural key unique per organization', () => {
    expect(modelBody('CommerceCustomer')).toMatch(/@@unique\(\[organizationId, externalId\]\)/);
  });

  it('stores money as integer cents, never Float or Decimal', () => {
    const order = modelBody('CommerceOrder');
    for (const field of ['subtotalCents', 'freightCents', 'discountCents', 'totalCents']) {
      expect(order).toMatch(new RegExp(`${field}\\s+Int`));
    }
    expect(order).not.toMatch(/Float/);
  });

  it('has no column capable of holding personal data in the clear', () => {
    const forbidden = /\b(email|documento|document|cpf|cnpj|clientId|client_id|phone)\s+String/i;
    for (const model of ['CommerceOrder', 'CommerceCustomer', 'AttributionTouch']) {
      const body = modelBody(model);
      const offending = body.split('\n').filter((line) => forbidden.test(line));
      expect(offending).toEqual([]);
    }
  });

  it('only exposes hashed identifiers on customer and attribution', () => {
    expect(modelBody('CommerceCustomer')).toMatch(/emailHash\s+String\?/);
    expect(modelBody('CommerceCustomer')).toMatch(/documentHash\s+String\?/);
    expect(modelBody('AttributionTouch')).toMatch(/visitorHash\s+String/);
  });

  it('keeps the webhook idempotency key as a primary key', () => {
    expect(modelBody('ProcessedWebhookEvent')).toMatch(/wamid\s+String\s+@id/);
  });

  it('scopes every tenant-owned model to an organization', () => {
    for (const model of [
      'CommerceOrder', 'CommerceOrderItem', 'CommerceCustomer',
      'AttributionTouch', 'SyncState', 'WhatsAppIdentity', 'Conversation', 'ToolCallLog',
    ]) {
      expect(modelBody(model)).toMatch(/organizationId\s+String/);
    }
  });

  it('indexes the columns the analytics queries filter on', () => {
    expect(modelBody('CommerceOrder')).toMatch(/@@index\(\[organizationId, emittedAt\]\)/);
    expect(modelBody('CommerceOrder')).toMatch(/@@index\(\[organizationId, statusGroup, emittedAt\]\)/);
    expect(modelBody('CommerceOrderItem')).toMatch(/@@index\(\[organizationId, sku, emittedAt\]\)/);
  });
});
