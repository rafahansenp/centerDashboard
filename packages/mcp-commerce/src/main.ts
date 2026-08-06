import { PrismaClient } from '@prisma/client';
import { createMetricServer, startStdio } from '@center/mcp-core';
import { createCommerceProvider } from './provider.js';

const prisma = new PrismaClient();

const server = createMetricServer({
  name: 'center-mcp-commerce',
  version: '0.0.0',
  provider: createCommerceProvider(prisma),
});

await startStdio(server);
