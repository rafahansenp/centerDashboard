import { PrismaClient } from '@prisma/client';
import { SecretBox } from '@center/secrets';
import { loadConfig } from '../src/config.js';
import { migrateToMultiTenant } from './lib/migrate-to-multitenant.js';

const config = loadConfig(process.env);

const prisma = new PrismaClient();
try {
  const report = await migrateToMultiTenant(prisma, new SecretBox(config.credentialsEncryptionKey));
  console.log(JSON.stringify(report));
} finally {
  await prisma.$disconnect();
}
