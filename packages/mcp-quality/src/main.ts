import { PrismaClient } from '@prisma/client';
import { createMetricServer, startStdio } from '@center/mcp-core';
import type { AnalysisTool } from '@center/mcp-core';
import { createRatingTrendTool } from './ratings.js';
import { createFeedbackByCategoryTool } from './feedback.js';

if (!process.env.DATABASE_URL) {
  // stderr, nunca stdout: stdout é o canal do protocolo MCP.
  console.error('mcp-quality: DATABASE_URL é obrigatório');
  process.exit(1);
}

const prisma = new PrismaClient();

const tools: AnalysisTool[] = [
  createRatingTrendTool(prisma),
  createFeedbackByCategoryTool(prisma),
];

// Servidor só de ferramentas: nota da loja e feedback são leituras/agregados
// do Postgres (sincronizados por store-sync), não séries temporais no
// sentido de query_metric — não há provider aqui, como em mcp-behavior.
await startStdio(
  createMetricServer({
    name: 'center-quality',
    version: '1.0.0',
    tools,
  }),
);
