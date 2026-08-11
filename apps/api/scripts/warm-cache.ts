import { PrismaClient } from '@prisma/client';
// Import nomeado, não default: sob este tsconfig (NodeNext + esModuleInterop),
// `import Redis from 'ioredis'` tipa o binding como o namespace do módulo
// inteiro (sem assinatura de construção) — mesma peculiaridade documentada em
// src/main.ts.
import { Redis } from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore, type McpServerConfig } from '@center/mcp-core';
import type { Granularity, MetricQuery } from '@center/shared';
import { loadConfig } from '../src/config.js';
import { resolveTenant } from '../src/tenant.js';

/** Exatamente as métricas dos KPIs da Visão geral. */
const HEADLINE_METRIC_IDS = [
  'commerce.revenue', 'commerce.orders', 'commerce.average_ticket',
  'commerce.new_customers', 'ga4.sessions', 'ga4.active_users',
];

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl);

const mcpServers: McpServerConfig[] = [
  { source: 'commerce', command: process.execPath, args: ['../../packages/mcp-commerce/dist/main.js'],
    // UAPPI_BASE_URL é repassada, mas `packages/mcp-commerce` não a lê hoje —
    // não há registro condicional de ferramenta nenhuma. `out_of_stock_products`
    // (T15) nunca foi implementada (spike bloqueado por falta de credencial da
    // Uappi) e por isso não está em ALLOWED_TOOLS/RANKINGS (ver routes/metrics.ts,
    // agent/tools.ts). A variável fica aqui pronta para quando a ferramenta
    // existir de fato.
    env: { DATABASE_URL: config.databaseUrl, UAPPI_BASE_URL: config.uappiBaseUrl,
      CREDENTIALS_ENCRYPTION_KEY: config.credentialsEncryptionKey } },
  { source: 'ga4', command: process.execPath, args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson, MOCK_EXTERNAL_APIS: String(config.mockExternalApis) } },
];

const pool = await McpPool.spawn(mcpServers);
const gateway = new MetricGateway(pool, new RedisCacheStore(redis));

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
function shift(days: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Exatamente os intervalos que os presets do PeriodPicker produzem.
const RANGES: Array<{ from: string; to: string; granularity: Granularity }> = [
  { from: today, to: today, granularity: 'day' },
  { from: shift(-6), to: today, granularity: 'day' },
  { from: shift(-29), to: today, granularity: 'day' },
  { from: shift(-89), to: today, granularity: 'week' },
];

const organizations = await prisma.organization.findMany({ select: { id: true } });
let warmed = 0;
let failed = 0;

for (const organization of organizations) {
  const tenant = await resolveTenant(prisma, organization.id);
  const queries: MetricQuery[] = RANGES.flatMap((range) =>
    HEADLINE_METRIC_IDS.map((metricId) => ({ metricId, ...range, tenant })));

  for (const query of queries) {
    try {
      await gateway.queryMetric(query);
      warmed += 1;
    } catch (error) {
      failed += 1;
      console.error(`falhou ${query.metricId} (${organization.id}):`, (error as Error).message);
    }
  }
}

console.log(`cache aquecido: ${warmed} consultas, ${failed} falhas`);
await gateway.close();
await prisma.$disconnect();
redis.disconnect();
