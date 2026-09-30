/** Mesma convenção de fuso de negócio usada em `@center/mcp-commerce` (T7/T8). */
const BUSINESS_TIME_ZONE_OFFSET = '-03:00';

/** Converte o range de datas de negócio nos instantes UTC correspondentes. */
export function rangeToUtc(from: string, to: string): { start: Date; end: Date } {
  return {
    start: new Date(`${from}T00:00:00${BUSINESS_TIME_ZONE_OFFSET}`),
    end: new Date(new Date(`${to}T00:00:00${BUSINESS_TIME_ZONE_OFFSET}`).getTime() + 24 * 60 * 60 * 1000),
  };
}
