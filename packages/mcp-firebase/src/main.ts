import { createMetricServer, startStdio } from '@center/mcp-core';
import { Ga4Client, type Ga4ClientLike } from '@center/mcp-ga4';
import { MockFirebaseClient } from './mock-client.js';
import { createFirebaseProvider } from './provider.js';
import { createShopFunnelTool } from './funnel.js';
import { createUsageSummaryTool } from './usage.js';
import { createCompareByVersionTool } from './compare.js';

// MOCK_EXTERNAL_APIS=true roda o servidor inteiro contra fixtures
// determinísticas — sem service account, sem propriedade GA4 do app real.
const mockMode = process.env.MOCK_EXTERNAL_APIS === 'true';

let client: Ga4ClientLike;
if (mockMode) {
  client = new MockFirebaseClient();
} else {
  // Firebase Analytics é a mesma API do GA4 (@google-analytics/data) contra
  // uma property diferente — reaproveita `Ga4Client` em vez de reimplementar.
  // Pode ser a mesma service account de GA4_CREDENTIALS_JSON se ela também
  // tiver acesso à property do app; separada aqui por isolamento.
  const credentialsJson = process.env.GA4_APP_CREDENTIALS_JSON || process.env.GA4_CREDENTIALS_JSON;
  if (!credentialsJson) {
    console.error('mcp-firebase: GA4_APP_CREDENTIALS_JSON (ou GA4_CREDENTIALS_JSON) é obrigatório');
    process.exit(1);
  }
  client = Ga4Client.fromCredentialsJson(credentialsJson);
}

await startStdio(
  createMetricServer({
    name: 'center-firebase',
    version: '1.0.0',
    provider: createFirebaseProvider(client),
    tools: [
      createUsageSummaryTool(client),
      createShopFunnelTool(client),
      createCompareByVersionTool(client),
    ],
  }),
);
