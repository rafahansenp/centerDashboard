import { hashPassword, verifyPassword } from '../auth/password.js';

describe('password hashing', () => {
  it('accepts the correct password', async () => {
    expect(await verifyPassword('senha-correta-123', await hashPassword('senha-correta-123'))).toBe(true);
  });

  it('rejects the wrong password', async () => {
    expect(await verifyPassword('errada', await hashPassword('senha-correta-123'))).toBe(false);
  });

  it('produces a different hash for the same password (salted)', async () => {
    expect(await hashPassword('mesma')).not.toBe(await hashPassword('mesma'));
  });

  it('returns false instead of throwing on a malformed stored hash', async () => {
    expect(await verifyPassword('qualquer', 'lixo-sem-separador')).toBe(false);
  });
});
