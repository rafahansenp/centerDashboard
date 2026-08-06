import { Pseudonymizer, PSEUDONYM_LENGTH } from '../pseudonymize.js';

const pepper = 'p'.repeat(32);
const other = 'q'.repeat(32);

describe('Pseudonymizer', () => {
  const subject = new Pseudonymizer(pepper);

  it('rejects a pepper shorter than 32 characters', () => {
    expect(() => new Pseudonymizer('curto')).toThrow('PII_PEPPER precisa de ao menos 32 caracteres');
  });

  it('is deterministic — the same input always yields the same hash', () => {
    expect(subject.hashEmail('ana@example.com')).toBe(subject.hashEmail('ana@example.com'));
  });

  it('produces a fixed length lowercase hex value', () => {
    const hash = subject.hashEmail('ana@example.com');
    expect(hash).toHaveLength(PSEUDONYM_LENGTH);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('normalises the email before hashing', () => {
    const canonical = subject.hashEmail('ana@example.com');
    expect(subject.hashEmail('  ANA@Example.COM  ')).toBe(canonical);
  });

  it('normalises the document by stripping punctuation', () => {
    const canonical = subject.hashDocument('12345678909');
    expect(subject.hashDocument('123.456.789-09')).toBe(canonical);
    expect(subject.hashDocument(' 123 456 789 09 ')).toBe(canonical);
  });

  it('separates namespaces so the same string in two roles never collides', () => {
    expect(subject.hashEmail('12345678909')).not.toBe(subject.hashDocument('12345678909'));
    expect(subject.hashVisitorId('12345678909')).not.toBe(subject.hashDocument('12345678909'));
  });

  it('produces different hashes under a different pepper', () => {
    expect(new Pseudonymizer(other).hashEmail('ana@example.com'))
      .not.toBe(subject.hashEmail('ana@example.com'));
  });

  it('never returns the original value', () => {
    const email = 'ana@example.com';
    const hash = subject.hashEmail(email);
    expect(hash).not.toContain('ana');
    expect(hash).not.toContain('example');
  });

  it('hashes the GA4 client id verbatim apart from trimming', () => {
    expect(subject.hashVisitorId(' 1234567890.1699999999 '))
      .toBe(subject.hashVisitorId('1234567890.1699999999'));
  });

  it('throws on an empty value instead of hashing the empty string', () => {
    expect(() => subject.hashEmail('   ')).toThrow('valor vazio não pode ser pseudonimizado');
    expect(() => subject.hashDocument('')).toThrow('valor vazio não pode ser pseudonimizado');
  });
});
