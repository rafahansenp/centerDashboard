import { resolvePeriodPhrase } from '../agent/date-resolver.js';

const TODAY = '2026-03-15'; // domingo

describe('resolvePeriodPhrase — relativos', () => {
  it.each([
    ['hoje', '2026-03-15', '2026-03-15', 'day'],
    ['ontem', '2026-03-14', '2026-03-14', 'day'],
    ['esta semana', '2026-03-09', '2026-03-15', 'day'],
    ['semana passada', '2026-03-02', '2026-03-08', 'day'],
    ['este mês', '2026-03-01', '2026-03-15', 'day'],
    ['mês passado', '2026-02-01', '2026-02-28', 'day'],
    ['este ano', '2026-01-01', '2026-03-15', 'month'],
    ['ano passado', '2025-01-01', '2025-12-31', 'month'],
  ])('resolves "%s"', (phrase, from, to, granularity) => {
    expect(resolvePeriodPhrase(phrase, TODAY)).toMatchObject({ from, to, granularity });
  });

  it('resolves "mês passado" in January crossing the year', () => {
    expect(resolvePeriodPhrase('mês passado', '2026-01-20')).toMatchObject({
      from: '2025-12-01', to: '2025-12-31',
    });
  });

  it('resolves "mês passado" in a leap year March with 29 days', () => {
    expect(resolvePeriodPhrase('mês passado', '2024-03-10')).toMatchObject({
      from: '2024-02-01', to: '2024-02-29',
    });
  });

  it('accepts the unaccented spelling', () => {
    expect(resolvePeriodPhrase('mes passado', TODAY)).toMatchObject({ from: '2026-02-01' });
  });
});

describe('resolvePeriodPhrase — "últimos N"', () => {
  it('resolves "últimos 7 dias" including today', () => {
    expect(resolvePeriodPhrase('últimos 7 dias', TODAY)).toMatchObject({
      from: '2026-03-09', to: '2026-03-15', granularity: 'day',
    });
  });

  it('accepts the unaccented form', () => {
    expect(resolvePeriodPhrase('ultimos 30 dias', TODAY)).toMatchObject({ from: '2026-02-14' });
  });

  it('switches to week granularity above 60 days', () => {
    expect(resolvePeriodPhrase('últimos 90 dias', TODAY)).toMatchObject({ granularity: 'week' });
  });

  it('resolves "últimos 3 meses"', () => {
    expect(resolvePeriodPhrase('últimos 3 meses', TODAY)).toMatchObject({
      from: '2025-12-01', to: '2026-03-15', granularity: 'month',
    });
  });

  it('resolves "últimas 2 semanas"', () => {
    expect(resolvePeriodPhrase('últimas 2 semanas', TODAY)).toMatchObject({
      from: '2026-03-02', to: '2026-03-15', granularity: 'week',
    });
  });
});

describe('resolvePeriodPhrase — mês nomeado', () => {
  it('resolves "janeiro" as the most recent January that already happened', () => {
    expect(resolvePeriodPhrase('janeiro', TODAY)).toMatchObject({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('resolves a future month in the current year as last year', () => {
    // Em 15/03/2026, "dezembro" só pode significar dez/2025.
    expect(resolvePeriodPhrase('dezembro', TODAY)).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('resolves "fevereiro de 2024" with 29 days', () => {
    expect(resolvePeriodPhrase('fevereiro de 2024', TODAY)).toMatchObject({
      from: '2024-02-01', to: '2024-02-29',
    });
  });

  it('resolves "março/2025"', () => {
    expect(resolvePeriodPhrase('março/2025', TODAY)).toMatchObject({ from: '2025-03-01', to: '2025-03-31' });
  });

  it('accepts the unaccented month name', () => {
    expect(resolvePeriodPhrase('marco de 2025', TODAY)).toMatchObject({ from: '2025-03-01' });
  });
});

describe('resolvePeriodPhrase — não reconhecido', () => {
  it('returns null for a phrase that is not a period', () => {
    expect(resolvePeriodPhrase('quanto vendemos', TODAY)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolvePeriodPhrase('', TODAY)).toBeNull();
  });

  it('returns null for a vague phrase instead of guessing', () => {
    expect(resolvePeriodPhrase('na época da promoção', TODAY)).toBeNull();
  });
});
