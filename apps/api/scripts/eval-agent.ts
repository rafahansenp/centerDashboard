import { PrismaClient } from '@prisma/client';
// Import nomeado, não default: sob este tsconfig (NodeNext + esModuleInterop),
// `import Redis from 'ioredis'` tipa o binding como o namespace do módulo
// inteiro (sem assinatura de construção) — mesma peculiaridade documentada em
// src/main.ts.
import { Redis } from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore } from '@center/mcp-core';
import { loadConfig } from '../src/config.js';
import { runAgent } from '../src/agent/agent.js';
import { resolveTenant } from '../src/tenant.js';

/** Uma pergunta por caso de uso do escopo, mais duas fora de escopo. */
const QUESTIONS = [
  'quanto vendemos hoje?',
  'quanto vendemos esta semana?',
  'quanto vendemos no mês passado?',
  'qual foi o ticket médio em fevereiro?',
  'quantos pedidos tivemos hoje?',
  'quantos pedidos foram cancelados este mês?',
  'quantos pedidos estão aguardando pagamento?',
  'quais compras falharam nos últimos 7 dias?',
  'qual produto mais vendeu no mês passado?',
  'qual produto caiu mais em vendas comparando com o mês anterior?',
  'qual categoria vendeu mais este mês?',
  'quantos clientes novos tivemos no mês passado?',
  'qual método de pagamento converte mais?',
  'qual campanha trouxe mais receita nos últimos 30 dias?',
  'qual origem trouxe mais usuários este mês?',
  'quantas sessões tivemos ontem?',
  'qual etapa do checkout tem maior abandono?',
  'qual dispositivo converte melhor?',
  'o aumento de usuários impactou o faturamento nos últimos 30 dias?',
  'quais canais possuem maior ticket médio?',
  // Fora de escopo — devem ser recusadas com clareza
  'qual versão do app está crashando mais?',
  'me manda a receita do bolo de cenoura',
];

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl);

const pool = await McpPool.spawn([
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
]);

const gateway = new MetricGateway(pool, new RedisCacheStore(redis));
const tenant = await resolveTenant(prisma, process.env.EVAL_ORG_ID ?? 'org_dev');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

const latencies: number[] = [];

for (const question of QUESTIONS) {
  const started = Date.now();
  const result = await runAgent({ gateway, tenant, today, history: [], userMessage: question });
  const elapsed = Date.now() - started;
  latencies.push(elapsed);

  console.log('\n─────────────────────────────────────────────');
  console.log(`P: ${question}`);
  console.log(`R: ${result.reply}`);
  console.log(`   [${elapsed}ms · ferramentas: ${
    result.toolCalls.map((c) => `${c.toolName}${c.success ? '' : ' (FALHOU)'}`).join(', ') || 'nenhuma'
  }]`);
}

latencies.sort((a, b) => a - b);
console.log(`\nLatência mediana: ${latencies[Math.floor(latencies.length / 2)]}ms`);

await gateway.close();
await prisma.$disconnect();
redis.disconnect();
