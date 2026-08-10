import { PrismaClient } from '@prisma/client';
// Import nomeado, não default: sob este tsconfig (NodeNext + esModuleInterop),
// `import Redis from 'ioredis'` tipa o binding como o namespace do módulo
// inteiro (sem assinatura de construção) — uma peculiaridade dos .d.ts da
// ioredis, não um erro no nosso código. Mesma correção já aplicada em
// `main.ts` e `eval-agent.ts`.
import { Redis } from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore, type McpServerConfig } from '@center/mcp-core';
import { loadConfig } from '../config.js';
import { CloudApiClient } from './cloud-api-client.js';
import { createWhatsAppWorker } from './worker.js';

const config = loadConfig(process.env);
const prisma = new PrismaClient();
// BullMQ exige maxRetriesPerRequest: null na conexão do worker.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const mcpServers: McpServerConfig[] = [
  { source: 'commerce', command: process.execPath, args: ['../../packages/mcp-commerce/dist/main.js'],
    // UAPPI_BASE_URL habilita out_of_stock_products (T15) condicionalmente — o
    // servidor só a registra se a variável existir, sem precisar de credencial fixa.
    env: { DATABASE_URL: config.databaseUrl, UAPPI_BASE_URL: config.uappiBaseUrl,
      CREDENTIALS_ENCRYPTION_KEY: config.credentialsEncryptionKey } },
  { source: 'ga4', command: process.execPath, args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson, MOCK_EXTERNAL_APIS: String(config.mockExternalApis) } },
  { source: 'behavior', command: process.execPath, args: ['../../packages/mcp-behavior/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson, MOCK_EXTERNAL_APIS: String(config.mockExternalApis) } },
];

const pool = await McpPool.spawn(mcpServers);
const gateway = new MetricGateway(pool, new RedisCacheStore(redis));
const cloudApi = new CloudApiClient(config.whatsapp);

const worker = createWhatsAppWorker({ prisma, gateway, cloudApi, config }, redis);

worker.on('failed', (job, error) => {
  console.error(`job ${job?.id} falhou (tentativa ${job?.attemptsMade}):`, error.message);
});
worker.on('completed', (job) => console.log(`job ${job.id} concluído`));
// Sem este listener, um 'error' emitido pelo Worker (blip de rede, Redis
// reiniciando, pool de conexões esgotado) derruba o processo inteiro — o
// EventEmitter do Node lança quando 'error' não tem nenhum listener.
worker.on('error', (error) => {
  console.error('worker do WhatsApp: erro de conexão', error.message);
});

console.log('worker do WhatsApp em execução');

async function shutdown(): Promise<void> {
  await worker.close();
  await gateway.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
