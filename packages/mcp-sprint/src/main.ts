import { PrismaClient } from '@prisma/client';
import { createMetricServer, startStdio } from '@center/mcp-core';
import type { AnalysisTool } from '@center/mcp-core';
import { createSprintSummaryTool } from './summary.js';
import { createSprintTasksTool } from './tasks.js';
import { createSprintCyclesTool } from './cycles.js';
import { createSprintTypeTrendTool } from './trend.js';

if (!process.env.DATABASE_URL) {
  console.error('mcp-sprint: DATABASE_URL é obrigatório');
  process.exit(1);
}

const prisma = new PrismaClient();

const tools: AnalysisTool[] = [
  createSprintSummaryTool(prisma),
  createSprintTasksTool(prisma),
  createSprintCyclesTool(prisma),
  createSprintTypeTrendTool(prisma),
];

// Servidor só de ferramentas: agregados do Monday.com (sincronizados por
// monday-sync), não uma série temporal — sem provider, como em mcp-behavior.
await startStdio(
  createMetricServer({
    name: 'center-sprint',
    version: '1.0.0',
    tools,
  }),
);
