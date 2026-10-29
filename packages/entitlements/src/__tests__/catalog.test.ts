import { MODULES, MODULE_KEYS, isModuleKey } from '../catalog.js';

describe('catalog', () => {
  it('lists the seven modules in catalog order', () => {
    expect(MODULES.map((m) => m.key)).toEqual([...MODULE_KEYS]);
    expect(MODULES).toHaveLength(7);
  });

  it('every requires is a subset of sources', () => {
    for (const m of MODULES) {
      for (const r of m.requires) expect(m.sources).toContain(r);
    }
  });

  it('isModuleKey rejects unknown keys', () => {
    expect(isModuleKey('billing')).toBe(false);
    expect(isModuleKey('quality')).toBe(true);
  });

  it('uses the exact display names and menu paths', () => {
    expect(MODULES.map((m) => [m.key, m.label, m.menuPath])).toEqual([
      ['overview', 'Visão geral', '/'],
      ['products', 'Produtos', '/produtos'],
      ['acquisition', 'Aquisição', '/aquisicao'],
      ['app_usage', 'Uso do app', '/uso-do-app'],
      ['quality', 'Qualidade', '/qualidade'],
      ['sprint', 'Sprint', '/sprint'],
      ['assistant', 'Assistente de IA', null],
    ]);
  });
});
