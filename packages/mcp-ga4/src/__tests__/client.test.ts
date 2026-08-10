import type { BetaAnalyticsDataClient } from '@google-analytics/data';
import { Ga4Client, fromGa4Date, type Ga4ReportParams } from '../client.js';

function stubApi(response: { rows?: unknown[] }) {
  return { runReport: jest.fn(async () => [response]) } as unknown as BetaAnalyticsDataClient;
}

const baseParams: Ga4ReportParams = {
  propertyId: '111222333',
  metricNames: ['sessions'],
  from: '2026-02-01',
  to: '2026-02-28',
  dimensionNames: ['date'],
  dimensionFilters: {},
};

describe('Ga4Client.runReport', () => {
  it('builds the request with the property path, date range and default limit', async () => {
    const api = stubApi({ rows: [] });
    await new Ga4Client(api).runReport(baseParams);
    expect(api.runReport).toHaveBeenCalledWith(expect.objectContaining({
      property: 'properties/111222333',
      dateRanges: [{ startDate: '2026-02-01', endDate: '2026-02-28' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      limit: 100_000,
    }));
  });

  it('honours an explicit limit instead of the 100k default', async () => {
    const api = stubApi({ rows: [] });
    await new Ga4Client(api).runReport({ ...baseParams, limit: 10 });
    expect(api.runReport).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });

  it('omits dimensionFilter entirely when there are no filters', async () => {
    const api = stubApi({ rows: [] });
    await new Ga4Client(api).runReport(baseParams);
    expect(api.runReport).toHaveBeenCalledWith(
      expect.not.objectContaining({ dimensionFilter: expect.anything() }),
    );
  });

  it('builds an AND group of EXACT-match filters when dimensionFilters is non-empty', async () => {
    const api = stubApi({ rows: [] });
    await new Ga4Client(api).runReport({
      ...baseParams, dimensionFilters: { campaign: 'blackfriday', device: 'mobile' },
    });
    expect(api.runReport).toHaveBeenCalledWith(expect.objectContaining({
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'campaign', stringFilter: { matchType: 'EXACT', value: 'blackfriday' } } },
            { filter: { fieldName: 'device', stringFilter: { matchType: 'EXACT', value: 'mobile' } } },
          ],
        },
      },
    }));
  });

  it('maps rows by dimension/metric name, in the order requested', async () => {
    const api = stubApi({
      rows: [{
        dimensionValues: [{ value: '20260201' }],
        metricValues: [{ value: '42' }],
      }],
    });
    const rows = await new Ga4Client(api).runReport(baseParams);
    expect(rows).toEqual([{ dimensions: { date: '20260201' }, metrics: { sessions: 42 } }]);
  });

  it('defaults a missing dimension value to an empty string and a missing metric to 0', async () => {
    const api = stubApi({ rows: [{ dimensionValues: [], metricValues: [] }] });
    const rows = await new Ga4Client(api).runReport(baseParams);
    expect(rows).toEqual([{ dimensions: { date: '' }, metrics: { sessions: 0 } }]);
  });

  it('returns an empty array when the API reports no rows', async () => {
    const api = stubApi({});
    const rows = await new Ga4Client(api).runReport(baseParams);
    expect(rows).toEqual([]);
  });
});

describe('Ga4Client.fromCredentialsJson', () => {
  it('builds a client from a service-account JSON string without any network call', () => {
    const credentialsJson = JSON.stringify({
      client_email: 'svc@example.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
    });
    expect(Ga4Client.fromCredentialsJson(credentialsJson)).toBeInstanceOf(Ga4Client);
  });
});

describe('fromGa4Date', () => {
  it('converts the compact GA4 date format to ISO', () => {
    expect(fromGa4Date('20260214')).toBe('2026-02-14');
  });
});
