import {
  SERIES_COLOR_BY_SOURCE, SERIES_COLOR_SLOTS, SERIES_SLOT_BY_SOURCE, SOURCE_LABEL,
} from '../lib/viz-colors.js';

describe('viz color assignment', () => {
  it('assigns a distinct slot to each source', () => {
    const slots = Object.values(SERIES_SLOT_BY_SOURCE);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('keeps the CSS variable in sync with the slot number', () => {
    for (const [source, slot] of Object.entries(SERIES_SLOT_BY_SOURCE)) {
      expect(SERIES_COLOR_BY_SOURCE[source as keyof typeof SERIES_COLOR_BY_SOURCE])
        .toBe(`var(--viz-${slot})`);
    }
  });

  it('labels every source in Portuguese', () => {
    for (const source of Object.keys(SERIES_SLOT_BY_SOURCE)) {
      expect(SOURCE_LABEL[source as keyof typeof SOURCE_LABEL]).toBeTruthy();
    }
  });

  it('exposes exactly four positional slots, all as CSS variables', () => {
    expect(SERIES_COLOR_SLOTS).toEqual([
      'var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)',
    ]);
  });

  it('never emits a Tailwind class name — colours are resolved at paint time', () => {
    // Uma classe montada por template string (`bg-viz-${n}`) seria invisível ao
    // scanner do Tailwind e sumiria no build de produção. Este teste trava a
    // decisão de usar `var(--viz-N)` em `style`.
    for (const value of Object.values(SERIES_COLOR_BY_SOURCE)) {
      expect(value).toMatch(/^var\(--viz-\d\)$/);
    }
  });
});
