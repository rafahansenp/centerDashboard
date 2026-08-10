import {
  FIXTURE_PURCHASE_PATH_ROWS,
  FIXTURE_SCREEN_IMPACT_ROWS,
  FIXTURE_TOTAL_BUYERS_ROW,
  MockBigQueryEventsClient,
} from '../mock-client.js';
import { createEventsBeforePurchaseTool } from '../purchase-path.js';

describe('MockBigQueryEventsClient', () => {
  it('returns the screen impact fixture when screenName is among the params', async () => {
    const rows = await new MockBigQueryEventsClient().query('SELECT 1', {
      screenName: 'Checkout', fromCompact: '20260201', toCompact: '20260228',
    });
    expect(rows).toEqual(FIXTURE_SCREEN_IMPACT_ROWS);
  });

  it('returns the total buyers fixture for the buyer-count query, identified by its SQL', async () => {
    // events_before_purchase (T36) issues two independent queries with the
    // identical param shape { fromCompact, toCompact } — params alone can't
    // tell them apart. buildTotalBuyersSql's SQL carries `AS buyers`, a
    // signature no other query in the system produces (see
    // purchase-path.test.ts's fakeClient(), the precedent for this check).
    const rows = await new MockBigQueryEventsClient().query(
      'SELECT COUNT(DISTINCT user_pseudo_id) AS buyers FROM `x.events_*` WHERE _TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact',
      { fromCompact: '20260201', toCompact: '20260228' },
    );
    expect(rows).toEqual([FIXTURE_TOTAL_BUYERS_ROW]);
  });

  it('returns the purchase path fixture otherwise', async () => {
    const rows = await new MockBigQueryEventsClient().query('SELECT 1', {
      fromCompact: '20260201', toCompact: '20260228',
    });
    expect(rows).toEqual(FIXTURE_PURCHASE_PATH_ROWS);
  });

  it('prioritizes screenName over the buyers SQL signature, should both ever appear together', async () => {
    const rows = await new MockBigQueryEventsClient().query(
      'SELECT COUNT(DISTINCT user_pseudo_id) AS buyers',
      { screenName: 'Checkout' },
    );
    expect(rows).toEqual(FIXTURE_SCREEN_IMPACT_ROWS);
  });

  it('never touches the network — resolves synchronously fast', async () => {
    const startedAt = Date.now();
    await new MockBigQueryEventsClient().query('SELECT 1', {});
    expect(Date.now() - startedAt).toBeLessThan(50);
  });
});

describe('events_before_purchase against the mock client (dev/demo mode)', () => {
  // Regressão-alvo: com o dispatch original de duas vias, tanto a query de
  // total de compradores quanto a de eventos precedentes caíam na mesma
  // fixture (FIXTURE_PURCHASE_PATH_ROWS, sem campo `buyers`), e
  // `buyerRows[0]?.buyers` lia `undefined` — reproduzindo, agora via mock, o
  // mesmo bug de undercounting que a correção real do T36 eliminou. Este
  // teste chama o tool de ponta a ponta, com as duas queries do
  // `Promise.all` disparadas pela MESMA instância do mock na MESMA chamada.
  it('reports a nonzero totalBuyers and a populated events list', async () => {
    const client = new MockBigQueryEventsClient();
    const tool = createEventsBeforePurchaseTool(client);
    const result = await tool.handler({
      from: '2026-02-01',
      to: '2026-02-28',
      tenant: { organizationId: 'org_1', externalIds: { ga4BigQueryDataset: 'analytics_123456' } },
    }) as { totalBuyers: number; events: Array<Record<string, number | string>> };

    expect(result.totalBuyers).toBe(FIXTURE_TOTAL_BUYERS_ROW.buyers);
    expect(result.totalBuyers).toBeGreaterThan(0);
    expect(result.events.length).toBe(FIXTURE_PURCHASE_PATH_ROWS.length);
    expect(result.events[0]).toMatchObject({ evento: 'page_view' });
  });
});

describe('fixture shape', () => {
  it('the total buyers fixture is consistent with the purchase path fixture\'s users columns', () => {
    // Nenhuma linha de FIXTURE_PURCHASE_PATH_ROWS deve superar o total de
    // compradores — senão os dados de demo pareceriam inconsistentes para
    // quem os inspecionasse (mais usuários com o evento do que compradores).
    for (const row of FIXTURE_PURCHASE_PATH_ROWS) {
      expect(row.users).toBeLessThanOrEqual(FIXTURE_TOTAL_BUYERS_ROW.buyers);
    }
  });

  it('screen impact fixture has exactly the two cohorts', () => {
    expect(FIXTURE_SCREEN_IMPACT_ROWS.map((row) => row.saw_screen).sort()).toEqual([false, true]);
  });
});
