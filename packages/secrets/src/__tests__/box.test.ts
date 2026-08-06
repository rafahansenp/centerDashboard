import { SecretBox } from '../box.js';

const key = 'a'.repeat(64); // 32 bytes em hex
const otherKey = 'b'.repeat(64);

describe('SecretBox', () => {
  const box = new SecretBox(key);

  it('rejects a key that is not 64 hex characters', () => {
    expect(() => new SecretBox('curto')).toThrow('chave precisa ter 64 caracteres hexadecimais');
    expect(() => new SecretBox('z'.repeat(64))).toThrow('chave precisa ter 64 caracteres hexadecimais');
  });

  it('round-trips a plaintext', () => {
    expect(box.decrypt(box.encrypt('minha-secret-key-da-uappi'))).toBe('minha-secret-key-da-uappi');
  });

  it('round-trips an empty string', () => {
    expect(box.decrypt(box.encrypt(''))).toBe('');
  });

  it('round-trips unicode content', () => {
    expect(box.decrypt(box.encrypt('senha-com-açentuação-é-çãz'))).toBe('senha-com-açentuação-é-çãz');
  });

  it('produces a different ciphertext each time — the IV is fresh per call', () => {
    expect(box.encrypt('mesmo-valor')).not.toBe(box.encrypt('mesmo-valor'));
  });

  it('prefixes the ciphertext with the format version', () => {
    expect(box.encrypt('x').startsWith('v1.')).toBe(true);
  });

  it('fails to decrypt with the wrong key', () => {
    const wrongBox = new SecretBox(otherKey);
    expect(() => wrongBox.decrypt(box.encrypt('segredo'))).toThrow();
  });

  it('fails to decrypt tampered ciphertext — GCM catches the modification', () => {
    const ciphertext = box.encrypt('segredo');
    const parts = ciphertext.split('.');
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]!.slice(0, -2)}00`].join('.');
    expect(() => box.decrypt(tampered)).toThrow();
  });

  it('throws a readable error on a malformed ciphertext', () => {
    expect(() => box.decrypt('não-é-um-texto-cifrado-valido')).toThrow('texto cifrado inválido');
    expect(() => box.decrypt('v1.só.duas.partes.demais')).toThrow('texto cifrado inválido');
  });

  it('throws on an unknown format version instead of silently misreading', () => {
    const ciphertext = box.encrypt('x');
    const withBadVersion = `v99${ciphertext.slice(2)}`;
    expect(() => box.decrypt(withBadVersion)).toThrow('versão de formato desconhecida');
  });
});

describe('SecretBox.decryptOrNull', () => {
  const box = new SecretBox(key);

  it('returns null for a null input without touching the crypto layer', () => {
    expect(box.decryptOrNull(null)).toBeNull();
  });

  it('decrypts a real ciphertext normally', () => {
    expect(box.decryptOrNull(box.encrypt('valor'))).toBe('valor');
  });
});
