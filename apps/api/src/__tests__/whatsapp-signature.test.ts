import { createHmac } from 'node:crypto';
import { signPayload, verifySignature } from '../whatsapp/signature.js';

const SECRET = 'app-secret-de-teste';
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));

describe('signPayload', () => {
  it('produces the sha256= prefixed hex digest Meta sends', () => {
    expect(signPayload(body, SECRET))
      .toBe(`sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`);
  });
});

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    expect(verifySignature(body, signPayload(body, SECRET), SECRET)).toBe(true);
  });

  it('rejects a body signed with another secret', () => {
    expect(verifySignature(body, signPayload(body, 'outro'), SECRET)).toBe(false);
  });

  it('rejects a body tampered with after signing', () => {
    expect(verifySignature(Buffer.from('{"object":"outro"}'), signPayload(body, SECRET), SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    expect(verifySignature(body, createHmac('sha256', SECRET).update(body).digest('hex'), SECRET)).toBe(false);
  });

  it('rejects a header of the wrong length instead of throwing', () => {
    expect(verifySignature(body, 'sha256=abc', SECRET)).toBe(false);
  });

  it('rejects a header with non-hex characters instead of throwing', () => {
    expect(verifySignature(body, `sha256=${'z'.repeat(64)}`, SECRET)).toBe(false);
  });
});
