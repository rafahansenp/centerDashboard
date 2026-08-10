import { PrismaClient } from '@prisma/client';
// Import nomeado, não default: sob este tsconfig (NodeNext + esModuleInterop),
// `import Redis from 'ioredis'` tipa o binding como o namespace do módulo
// inteiro (sem assinatura de construção) — mesma peculiaridade documentada em
// src/main.ts.
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';

const STALE_SYNC_MINUTES = 90;
const QUEUE_DEPTH_ALARM = 50;

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl);

const problems: string[] = [];

// Primeiro de todos: o modo mock não quebra nada visivelmente, ele só serve
// dados inventados em silêncio. Se estiver ligado, nenhum outro sinal importa.
if (config.mockExternalApis) {
  problems.push('MOCK_EXTERNAL_APIS está ligado — os dados servidos são fixtures, não reais');
}

const syncStates = await prisma.syncState.findMany({
  include: { organization: { select: { name: true } } },
});

for (const state of syncStates) {
  if (state.lastError) {
    problems.push(`sync de "${state.organization.name}" com erro: ${state.lastError}`);
  }
  if (!state.lastSyncedAt) {
    problems.push(`sync de "${state.organization.name}" nunca rodou`);
    continue;
  }
  const minutesAgo = (Date.now() - state.lastSyncedAt.getTime()) / 60_000;
  if (minutesAgo > STALE_SYNC_MINUTES) {
    problems.push(
      `sync de "${state.organization.name}" parado há ${Math.round(minutesAgo)} minutos`,
    );
  }
}

// Fila crescendo = worker morto. Passando de 24h, o envio começa a falhar com
// o erro 131047 da Meta (fora da janela de resposta).
const waiting = await redis.llen('bull:whatsapp-inbound:wait');
if (waiting > QUEUE_DEPTH_ALARM) {
  problems.push(`fila do WhatsApp com ${waiting} mensagens aguardando`);
}

const since = new Date(Date.now() - 60 * 60_000);
const toolStats = await prisma.toolCallLog.groupBy({
  by: ['success'],
  where: { createdAt: { gte: since } },
  _count: true,
});
const failures = toolStats.find((row) => row.success === false)?._count ?? 0;
const total = toolStats.reduce((acc, row) => acc + row._count, 0);
if (total > 0 && failures / total > 0.2) {
  problems.push(`${failures} de ${total} chamadas de ferramenta falharam na última hora`);
}

if (problems.length === 0) {
  console.log('tudo saudável');
} else {
  console.error('PROBLEMAS DETECTADOS:');
  for (const problem of problems) console.error(` - ${problem}`);
}

await prisma.$disconnect();
redis.disconnect();
// Saída não-zero permite que o cron dispare alerta sem parser de log.
process.exit(problems.length === 0 ? 0 : 1);
