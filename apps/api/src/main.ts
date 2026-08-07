import { PrismaClient } from '@prisma/client';
// Import nomeado, não default: sob este tsconfig (NodeNext + esModuleInterop),
// `import Redis from 'ioredis'` tipa o binding como o namespace do módulo
// inteiro (sem assinatura de construção) — uma peculiaridade dos .d.ts da
// ioredis, não um erro no nosso código. `@center/mcp-core` já importa o TIPO
// `Redis` da mesma forma nomeada; aqui trazemos também o valor em runtime.
import { Redis } from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore, type McpServerConfig } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { BullMessageQueue } from './whatsapp/queue.js';

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

// Cada MCP server roda como processo filho, conectado por stdio. Adicionar
// uma quarta fonte é uma entrada neste array.
const mcpServers: McpServerConfig[] = [
  {
    source: 'commerce',
    command: process.execPath,
    args: ['../../packages/mcp-commerce/dist/main.js'],
    // UAPPI_BASE_URL habilita out_of_stock_products (T15) condicionalmente — o
    // servidor só a registra se a variável existir, sem precisar de credencial fixa.
    env: { DATABASE_URL: config.databaseUrl, UAPPI_BASE_URL: config.uappiBaseUrl,
      CREDENTIALS_ENCRYPTION_KEY: config.credentialsEncryptionKey },
  },
  {
    source: 'ga4',
    command: process.execPath,
    args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson, MOCK_EXTERNAL_APIS: String(config.mockExternalApis) },
  },
];

const pool = await McpPool.spawn(mcpServers);
const gateway = new MetricGateway(pool, new RedisCacheStore(redis));
const queue = new BullMessageQueue(redis);
// Decifra uappiApiKey/uappiSecretKey (T24B) — nunca lidos em claro do Postgres.
const secretBox = new SecretBox(config.credentialsEncryptionKey);

const app = await buildServer({
  config, prisma, gateway,
  pseudonymizer: new Pseudonymizer(config.piiPepper),
  secretBox,
  queue,
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'encerrando');
  await app.close();
  await queue.close();
  await gateway.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
