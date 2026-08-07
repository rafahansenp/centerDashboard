import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { ApiError, apiClient, setAuthToken } from '../lib/api-client.js';
import { formatBucketLabel, formatMetricValue } from '../lib/format.js';

const series = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency', granularity: 'day',
  total: 55000, points: [{ date: '2026-01-01', value: 55000 }],
};

const query = {
  metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-31', granularity: 'day' as const,
};

afterEach(() => setAuthToken(null));

describe('apiClient.queryMetric', () => {
  it('posts the query and returns the series', async () => {
    mswServer.use(http.post('/api/metrics/query', () => HttpResponse.json(series)));
    expect(await apiClient.queryMetric(query)).toEqual(series);
  });

  it('sends the bearer token once it is set', async () => {
    let received: string | null = null;
    mswServer.use(http.post('/api/metrics/query', ({ request }) => {
      received = request.headers.get('authorization');
      return HttpResponse.json(series);
    }));
    setAuthToken('token-abc');
    await apiClient.queryMetric(query);
    expect(received).toBe('Bearer token-abc');
  });

  it('throws ApiError carrying the status and message on 400', async () => {
    mswServer.use(http.post('/api/metrics/query', () =>
      HttpResponse.json({ message: 'intervalo excede o máximo de 400 dias' }, { status: 400 })));
    await expect(apiClient.queryMetric(query)).rejects.toMatchObject({
      name: 'ApiError', status: 400, message: 'intervalo excede o máximo de 400 dias',
    });
  });

  it('throws ApiError on 502', async () => {
    mswServer.use(http.post('/api/metrics/query', () =>
      HttpResponse.json({ message: 'Uappi indisponível' }, { status: 502 })));
    await expect(apiClient.queryMetric(query)).rejects.toBeInstanceOf(ApiError);
  });

  it('clears the token on 401 so the guard can redirect', async () => {
    mswServer.use(http.post('/api/metrics/query', () =>
      HttpResponse.json({ message: 'token inválido' }, { status: 401 })));
    setAuthToken('token-expirado');
    await expect(apiClient.queryMetric(query)).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem('center.token')).toBeNull();
  });
});

describe('apiClient.callTool', () => {
  it('posts to the tool route of the given source', async () => {
    let path = '';
    mswServer.use(http.post('/api/tools/:source/:name', ({ request }) => {
      path = new URL(request.url).pathname;
      return HttpResponse.json({ rows: [] });
    }));
    await apiClient.callTool('commerce', 'top_products', { from: '2026-01-01', to: '2026-01-31' });
    expect(path).toBe('/api/tools/commerce/top_products');
  });
});

describe('formatMetricValue', () => {
  it('formats currency from cents to BRL', () => {
    // Intl.NumberFormat('pt-BR', { style: 'currency' }) inserts U+00A0
    // (non-breaking space) between "R$" and the amount, not a literal space —
    // that's correct typography (keeps the symbol glued to the value across a
    // line wrap), so we normalize it here rather than in formatMetricValue.
    expect(formatMetricValue(123456, 'currency').replace(/ /g, ' ')).toBe('R$ 1.234,56');
  });

  it('formats zero cents', () => {
    expect(formatMetricValue(0, 'currency').replace(/ /g, ' ')).toBe('R$ 0,00');
  });

  it('formats counts with thousand separators and no decimals', () => {
    expect(formatMetricValue(1234567, 'count')).toBe('1.234.567');
  });

  it('formats ratios as percentages', () => {
    expect(formatMetricValue(0.1234, 'ratio')).toBe('12,3%');
  });

  it('formats durations in minutes and seconds', () => {
    expect(formatMetricValue(125, 'duration')).toBe('2min 5s');
  });
});

describe('formatBucketLabel', () => {
  it('shows day and month for day granularity', () => {
    expect(formatBucketLabel('2026-03-09', 'day')).toBe('09/03');
  });

  it('shows the month name for month granularity', () => {
    expect(formatBucketLabel('2026-03-01', 'month')).toBe('mar/26');
  });

  it('shows the week start for week granularity', () => {
    expect(formatBucketLabel('2026-03-09', 'week')).toBe('sem. 09/03');
  });
});
