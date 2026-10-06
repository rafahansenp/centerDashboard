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

/**
 * Uma pergunta por caso de uso do escopo, mais duas fora de escopo. `expect`
 * lista as ferramentas aceitáveis; `[]` significa que o agente deve recusar
 * sem chamar nenhuma.
 */
const QUESTIONS: Array<{ q: string; expect: string[] }> = [
  { q: 'quanto vendemos hoje?', expect: ['consultar_metrica'] },
  { q: 'quanto vendemos esta semana?', expect: ['consultar_metrica'] },
  { q: 'quanto vendemos no mês passado?', expect: ['consultar_metrica'] },
  { q: 'qual foi o ticket médio em fevereiro?', expect: ['consultar_metrica'] },
  { q: 'quantos pedidos tivemos hoje?', expect: ['consultar_metrica'] },
  { q: 'quantos pedidos foram cancelados este mês?', expect: ['ranking', 'consultar_metrica'] },
  { q: 'quantos pedidos estão aguardando pagamento?', expect: ['ranking'] },
  { q: 'quais compras falharam nos últimos 7 dias?', expect: ['ranking'] },
  { q: 'qual produto mais vendeu no mês passado?', expect: ['ranking'] },
  { q: 'qual produto caiu mais em vendas comparando com o mês anterior?', expect: ['comparar_periodos', 'ranking'] },
  { q: 'qual categoria vendeu mais este mês?', expect: ['ranking'] },
  { q: 'quantos clientes novos tivemos no mês passado?', expect: ['consultar_metrica'] },
  { q: 'qual método de pagamento converte mais?', expect: ['ranking'] },
  { q: 'qual campanha trouxe mais receita nos últimos 30 dias?', expect: ['ranking'] },
  { q: 'qual origem trouxe mais usuários este mês?', expect: ['ranking'] },
  { q: 'quantas sessões tivemos ontem?', expect: ['consultar_metrica'] },
  { q: 'qual etapa do checkout tem maior abandono?', expect: ['funil_de_compra'] },
  { q: 'qual dispositivo converte melhor?', expect: ['ranking'] },
  { q: 'o aumento de usuários impactou o faturamento nos últimos 30 dias?', expect: ['correlacionar'] },
  { q: 'quais canais possuem maior ticket médio?', expect: ['ranking'] },
  // Fora de escopo — devem ser recusadas com clareza
  { q: 'qual versão do app está crashando mais?', expect: [] },
  { q: 'me manda a receita do bolo de cenoura', expect: [] },
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
let toolHits = 0;
let fallbacks = 0;

for (const { q, expect } of QUESTIONS) {
  const started = Date.now();
  const result = await runAgent({ gateway, tenant, today, history: [], userMessage: q });
  const elapsed = Date.now() - started;
  latencies.push(elapsed);

  const used = result.toolCalls.map((c) => c.toolName);
  const allOk = result.toolCalls.every((c) => c.success);
  const hit = expect.length === 0
    ? used.length === 0
    : used.some((name) => expect.includes(name)) && allOk;
  if (hit) toolHits += 1;
  if (result.reply.startsWith('Não consegui consultar os dados agora')) fallbacks += 1;

  console.log('\n─────────────────────────────────────────────');
  console.log(`P: ${q}`);
  console.log(`R: ${result.reply}`);
  console.log(`   [${elapsed}ms · ${hit ? 'OK' : 'ERRO'} · esperado: ${expect.join('|') || 'nenhuma'} · ferramentas: ${
    result.toolCalls.map((c) => `${c.toolName}${c.success ? '' : ' (FALHOU)'}`).join(', ') || 'nenhuma'
  }]`);
}

latencies.sort((a, b) => a - b);
console.log(`\nModelo:${process.env.LLM_BASE_URL ? `${process.env.LLM_MODEL ?? 'qwen3:8b'} @ ${process.env.LLM_BASE_URL}` : 'claude-sonnet-5 (Anthropic)'}`);
console.log(`Ferramenta certa: ${toolHits}/${QUESTIONS.length} · respostas de fallback: ${fallbacks}`);
console.log(`Latência mediana: ${latencies[Math.floor(latencies.length / 2)]}ms`);

await gateway.close();
await prisma.$disconnect();
redis.disconnect();
