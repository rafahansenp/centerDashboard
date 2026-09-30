import { MockFirebaseClient } from '../mock-client.js';

const client = new MockFirebaseClient();
const period = { from: '2026-08-01', to: '2026-08-05' };

describe('MockFirebaseClient', () => {
  it('is deterministic: the same query returns the same values twice', async () => {
    const params = { propertyId: 'x', metricNames: ['activeUsers'], dimensionNames: ['eventName'], dimensionFilters: {}, ...period };
    const [first, second] = await Promise.all([client.runReport(params), client.runReport(params)]);
    expect(second).toEqual(first);
  });

  it('returns one row per known app event when grouped by eventName', async () => {
    const rows = await client.runReport({
      propertyId: 'x', metricNames: ['activeUsers'], dimensionNames: ['eventName'], dimensionFilters: {}, ...period,
    });
    const keys = rows.map((row) => row.dimensions.eventName);
    expect(keys).toContain('cadastro_usuario');
    expect(keys).toContain('Loja_view_promotion');
  });

  it('varies per event when comparing two versions — never the same ratio for every row', async () => {
    const forVersion = (appVersion: string) =>
      client.runReport({
        propertyId: 'x', metricNames: ['activeUsers'], dimensionNames: ['eventName'],
        dimensionFilters: { appVersion }, ...period,
      });

    const [previous, current] = await Promise.all([forVersion('2.3.1'), forVersion('2.4.0')]);
    const byEvent = (rows: Awaited<ReturnType<typeof forVersion>>) =>
      new Map(rows.map((row) => [row.dimensions.eventName ?? '', row.metrics.activeUsers ?? 0]));
    const previousByEvent = byEvent(previous);
    const currentByEvent = byEvent(current);

    const ratios = [...previousByEvent.entries()].map(([event, value]) => value / (currentByEvent.get(event) || 1));

    // A proporção precisa variar entre eventos — sem isso a coluna
    // "Variação" da tela de Uso do App sairia igual em toda linha, exatamente
    // o problema que motivou este redesenho (ver versionFactor em mock-client.ts).
    expect(new Set(ratios.map((r) => r.toFixed(2))).size).toBeGreaterThan(1);
  });

  it('never changes the most recent version (APP_VERSIONS[0]) — it is always the 1x base', async () => {
    const withVersion = await client.runReport({
      propertyId: 'x', metricNames: ['activeUsers'], dimensionNames: ['eventName'],
      dimensionFilters: { appVersion: '2.4.0' }, ...period,
    });
    const withoutFilter = await client.runReport({
      propertyId: 'x', metricNames: ['activeUsers'], dimensionNames: ['eventName'],
      dimensionFilters: {}, ...period,
    });
    expect(withVersion).toEqual(withoutFilter);
  });

  it('produces a date series when the date dimension is requested', async () => {
    const rows = await client.runReport({
      propertyId: 'x', metricNames: ['activeUsers'], dimensionNames: ['date'], dimensionFilters: {}, ...period,
    });
    // from/to são 5 dias inclusive.
    expect(rows).toHaveLength(5);
    expect(rows[0]?.dimensions.date).toBe('20260801');
  });
});
