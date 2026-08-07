import type { Granularity } from '@center/shared';

export interface ResolvedPeriod {
  from: string;
  to: string;
  granularity: Granularity;
  label: string;
}

export const MONTH_NAMES_PT: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

/** Dia 0 do mês seguinte = último dia deste mês. Cobre bissexto sem tabela. */
function lastDayOfMonth(year: number, month: number): string {
  return toIso(new Date(Date.UTC(year, month, 0)));
}

function firstDayOfMonth(year: number, month: number): string {
  return toIso(new Date(Date.UTC(year, month - 1, 1)));
}

/** Segunda-feira da semana ISO que contém `isoDate`. */
function mondayOf(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return toIso(date);
}

function normalize(phrase: string): string {
  return phrase
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    // Remove acentos para que "últimos"/"ultimos" e "março"/"marco" batam igual.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Converte uma expressão de período em português numa janela concreta.
 * Devolve `null` quando a frase não é um período — o chamador então pede as
 * datas ao usuário, em vez de adivinhar.
 */
export function resolvePeriodPhrase(phrase: string, today: string): ResolvedPeriod | null {
  const text = normalize(phrase);
  if (text === '') return null;

  const [year, month] = today.split('-').map(Number) as [number, number];

  if (text === 'hoje') return { from: today, to: today, granularity: 'day', label: 'hoje' };

  if (text === 'ontem') {
    const yesterday = shiftDays(today, -1);
    return { from: yesterday, to: yesterday, granularity: 'day', label: 'ontem' };
  }

  if (text === 'esta semana' || text === 'essa semana') {
    return { from: mondayOf(today), to: today, granularity: 'day', label: 'esta semana' };
  }

  if (text === 'semana passada' || text === 'ultima semana') {
    const lastMonday = shiftDays(mondayOf(today), -7);
    return { from: lastMonday, to: shiftDays(lastMonday, 6), granularity: 'day', label: 'semana passada' };
  }

  if (text === 'este mes' || text === 'esse mes' || text === 'mes atual') {
    return { from: firstDayOfMonth(year, month), to: today, granularity: 'day', label: 'este mês' };
  }

  if (text === 'mes passado' || text === 'ultimo mes') {
    const previousMonth = month === 1 ? 12 : month - 1;
    const previousYear = month === 1 ? year - 1 : year;
    return {
      from: firstDayOfMonth(previousYear, previousMonth),
      to: lastDayOfMonth(previousYear, previousMonth),
      granularity: 'day',
      label: 'mês passado',
    };
  }

  if (text === 'este ano' || text === 'esse ano' || text === 'ano atual') {
    return { from: firstDayOfMonth(year, 1), to: today, granularity: 'month', label: 'este ano' };
  }

  if (text === 'ano passado' || text === 'ultimo ano') {
    return {
      from: firstDayOfMonth(year - 1, 1), to: lastDayOfMonth(year - 1, 12),
      granularity: 'month', label: 'ano passado',
    };
  }

  const lastN = text.match(/^(?:ultimos?|ultimas?)\s+(\d{1,3})\s+(dias?|semanas?|meses|mes)$/);
  if (lastN) {
    const amount = Number(lastN[1]);
    const unit = lastN[2]!;

    if (unit.startsWith('dia')) {
      return {
        from: shiftDays(today, -(amount - 1)), to: today,
        // Mais de ~60 pontos diários deixam o resumo e o eixo ilegíveis.
        granularity: amount > 60 ? 'week' : 'day',
        label: `últimos ${amount} dias`,
      };
    }

    if (unit.startsWith('semana')) {
      return {
        from: shiftDays(today, -(amount * 7 - 1)), to: today,
        granularity: 'week', label: `últimas ${amount} semanas`,
      };
    }

    const startMonth = month - amount;
    const normalizedYear = year + Math.floor((startMonth - 1) / 12);
    const normalizedMonth = ((((startMonth - 1) % 12) + 12) % 12) + 1;
    return {
      from: firstDayOfMonth(normalizedYear, normalizedMonth), to: today,
      granularity: 'month', label: `últimos ${amount} meses`,
    };
  }

  const named = text.match(/^([a-z]+)(?:\s*(?:de|\/)\s*(\d{4}))?$/);
  if (named) {
    const monthNumber = MONTH_NAMES_PT[named[1]!];
    if (monthNumber) {
      // Sem ano explícito: o mês mais recente que já começou. "dezembro" em
      // março de 2026 só pode ser dez/2025.
      const explicitYear = named[2] ? Number(named[2]) : undefined;
      const resolvedYear = explicitYear ?? (monthNumber > month ? year - 1 : year);
      return {
        from: firstDayOfMonth(resolvedYear, monthNumber),
        to: lastDayOfMonth(resolvedYear, monthNumber),
        granularity: 'day',
        label: `${named[1]} de ${resolvedYear}`,
      };
    }
  }

  return null;
}
