import { PrismaClient } from '@prisma/client';
// Importa do `dist/`, não de `src/`: `node --experimental-strip-types` só
// apaga sintaxe de tipos, não remapeia especificadores `.js` para arquivos
// `.ts` irmãos — `src/auth/password.js` nunca existiria. O `dist/` já tem o
// `.js` compilado, e o Step 6 sempre roda `pnpm build` antes de `db:seed`.
import { hashPassword } from '../dist/auth/password.js';

const prisma = new PrismaClient();

const organization = await prisma.organization.upsert({
  where: { id: 'org_dev' },
  update: {},
  create: {
    id: 'org_dev',
    name: 'Loja de Desenvolvimento',
    uappiApiKey: process.env.SEED_UAPPI_API_KEY ?? null,
    uappiSecretKey: process.env.SEED_UAPPI_SECRET_KEY ?? null,
    ga4PropertyId: process.env.SEED_GA4_PROPERTY_ID ?? null,
  },
});

await prisma.user.upsert({
  where: { email: 'admin@center.local' },
  update: {},
  create: {
    email: 'admin@center.local',
    name: 'Admin Dev',
    role: 'ADMIN',
    passwordHash: await hashPassword('center-dev-123'),
    organizationId: organization.id,
  },
});

console.log('seed concluído: admin@center.local / center-dev-123');
await prisma.$disconnect();
