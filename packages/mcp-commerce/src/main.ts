import { PrismaClient } from '@prisma/client';
import { createMetricServer, startStdio } from '@center/mcp-core';
import type { AnalysisTool } from '@center/mcp-core';
import { createCommerceProvider } from './provider.js';
import {
  createFailedOrdersTool, createOrdersByStatusTool, createPaymentMethodTool,
} from './status.js';
import {
  createCompareProductsTool, createTopCategoriesTool, createTopProductsTool,
} from './rankings.js';
import {
  createCampaignConversionTool, createCampaignRevenueTool, createChannelTicketTool,
  createDeviceRevenueTool, createReturningCustomersTool,
} from './attribution.js';

if (!process.env.DATABASE_URL) {
  // stderr, nunca stdout: stdout é o canal do protocolo MCP.
  console.error('mcp-commerce: DATABASE_URL é obrigatório');
  process.exit(1);
}

const prisma = new PrismaClient();

const tools: AnalysisTool[] = [
  createOrdersByStatusTool(prisma),
  createFailedOrdersTool(prisma),
  createPaymentMethodTool(prisma),
  createTopProductsTool(prisma),
  createTopCategoriesTool(prisma),
  createCompareProductsTool(prisma),
  createCampaignRevenueTool(prisma),
  createChannelTicketTool(prisma),
  createDeviceRevenueTool(prisma),
  createCampaignConversionTool(prisma),
  createReturningCustomersTool(prisma),
];

// `out_of_stock_products` (T15) fica pendente: o spike do catálogo/estoque da
// Uappi foi bloqueado por falta de acesso real à API — ver
// `docs/uappi-catalog-spike.md`. Sem confirmar o endpoint real, não há
// contrato para implementar aqui.

await startStdio(
  createMetricServer({
    name: 'center-commerce',
    version: '1.0.0',
    provider: createCommerceProvider(prisma),
    tools,
  }),
);
