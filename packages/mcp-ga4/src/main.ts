import { createMetricServer, startStdio } from '@center/mcp-core';
import { Ga4Client } from './client.js';
import { MockGa4Client } from './mock-client.js';
import type { Ga4ClientLike } from './interface.js';
import { createGa4Provider } from './provider.js';
import {
  createAppVersionsTool, createCampaignUsersTool, createCompareEventsTool,
  createDevicePerformanceTool, createPagePerformanceTool, createTopEventsTool,
  createTrafficSourcesTool,
} from './rankings.js';
import { createCheckoutFunnelTool } from './funnel.js';

// MOCK_EXTERNAL_APIS=true (T4, T17B) roda o servidor inteiro contra fixtures
// determinísticas — sem service account, sem propriedade GA4 real.
const mockMode = process.env.MOCK_EXTERNAL_APIS === 'true';

let client: Ga4ClientLike;
if (mockMode) {
  client = new MockGa4Client();
} else {
  const credentialsJson = process.env.GA4_CREDENTIALS_JSON;
  if (!credentialsJson) {
    console.error('mcp-ga4: GA4_CREDENTIALS_JSON é obrigatório (JSON da service account)');
    process.exit(1);
  }
  client = Ga4Client.fromCredentialsJson(credentialsJson);
}

await startStdio(
  createMetricServer({
    name: 'center-ga4',
    version: '1.0.0',
    provider: createGa4Provider(client),
    tools: [
      createTrafficSourcesTool(client),
      createCampaignUsersTool(client),
      createDevicePerformanceTool(client),
      createPagePerformanceTool(client),
      createAppVersionsTool(client),
      createTopEventsTool(client),
      createCompareEventsTool(client),
      createCheckoutFunnelTool(client),
    ],
  }),
);
