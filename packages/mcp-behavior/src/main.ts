import { createMetricServer, startStdio } from '@center/mcp-core';
import { BigQueryEventsClient } from './client.js';
import { MockBigQueryEventsClient } from './mock-client.js';
import type { BigQueryEventsClientLike } from './interface.js';
import { createEventsBeforePurchaseTool } from './purchase-path.js';
import { createScreenAbandonImpactTool } from './screen-impact.js';

// MOCK_EXTERNAL_APIS=true (T4, T36B) roda contra as duas fixtures fixas —
// sem export do GA4 para BigQuery configurado.
let client: BigQueryEventsClientLike;
if (process.env.MOCK_EXTERNAL_APIS === 'true') {
  client = new MockBigQueryEventsClient();
} else {
  const credentialsJson = process.env.GA4_CREDENTIALS_JSON;
  if (!credentialsJson) {
    console.error('mcp-behavior: GA4_CREDENTIALS_JSON é obrigatório (service account com acesso ao BigQuery)');
    process.exit(1);
  }
  client = BigQueryEventsClient.fromCredentialsJson(credentialsJson);
}

// Servidor só de ferramentas: não expõe `query_metric` porque não há série
// temporal aqui — as duas perguntas são de coorte, não de evolução no tempo.
await startStdio(
  createMetricServer({
    name: 'center-behavior',
    version: '1.0.0',
    tools: [
      createEventsBeforePurchaseTool(client),
      createScreenAbandonImpactTool(client),
    ],
  }),
);
