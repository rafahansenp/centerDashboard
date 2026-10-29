import { slugify } from '../lib/slug.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Loja de Desenvolvimento')).toBe('loja-de-desenvolvimento');
  });
  it('strips accents and symbols', () => {
    expect(slugify('Ação & Cia.')).toBe('acao-cia');
  });
  it('falls back to "cliente" when nothing is left', () => {
    expect(slugify('!!!')).toBe('cliente');
  });
});
