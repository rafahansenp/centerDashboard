import { PrismaClient } from '@prisma/client';
import { MODULE_KEYS } from '@center/entitlements';
import { SecretBox } from '@center/secrets';
// Importa do `dist/`, não de `src/`: `node --experimental-strip-types` só
// apaga sintaxe de tipos, não remapeia especificadores `.js` para arquivos
// `.ts` irmãos — `src/auth/password.js` nunca existiria. O `dist/` já tem o
// `.js` compilado, e o Step 6 sempre roda `pnpm build` antes de `db:seed`.
import { hashPassword } from '../dist/auth/password.js';
import { encryptSecrets } from '../dist/integrations/repository.js';

const prisma = new PrismaClient();

const organization = await prisma.organization.upsert({
  where: { id: 'org_dev' },
  update: {},
  create: {
    id: 'org_dev',
    name: 'Loja de Desenvolvimento',
    slug: 'loja-de-desenvolvimento',
  },
});

// Os 7 módulos contratados (idempotente: ignora os que já existem).
await prisma.organizationModule.createMany({
  data: MODULE_KEYS.map((moduleKey) => ({ organizationId: organization.id, moduleKey, origin: 'MANUAL' as const })),
  skipDuplicates: true,
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

// Integração COMMERCE só existe se as duas credenciais da Uappi foram dadas;
// os segredos vão cifrados, num único JSON, como em produção.
const apiKey = process.env.SEED_UAPPI_API_KEY;
const secretKey = process.env.SEED_UAPPI_SECRET_KEY;
if (apiKey && secretKey) {
  const box = new SecretBox(process.env.CREDENTIALS_ENCRYPTION_KEY ?? '');
  await prisma.integration.upsert({
    where: { organizationId_kind: { organizationId: organization.id, kind: 'COMMERCE' } },
    update: {},
    create: {
      organizationId: organization.id,
      kind: 'COMMERCE',
      provider: 'UAPPI',
      config: {},
      secrets: encryptSecrets(box, { apiKey, secretKey }),
      secretsUpdatedAt: new Date(),
    },
  });
}

console.log('seed concluído: admin@center.local / center-dev-123');
await prisma.$disconnect();
