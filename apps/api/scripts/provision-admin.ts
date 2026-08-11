import { PrismaClient } from '@prisma/client';
import { ProvisionRefusedError, parseProvisionEnv, provisionFirstAdmin } from './lib/provision-admin.js';

const DUPLICATE_KEY = 'P2002';

const prisma = new PrismaClient();

async function main(): Promise<number> {
  const input = parseProvisionEnv(process.env);

  try {
    const result = await provisionFirstAdmin(prisma, input);
    console.log(
      `organização "${result.organizationName}" (${result.organizationId}) criada. `
        + `admin ${result.email} (${result.userId}) criado — guarde a senha informada, `
        + 'ela não é exibida novamente.',
    );
    return 0;
  } catch (error) {
    if (error instanceof ProvisionRefusedError) {
      console.error(`recusado: ${error.message}`);
      return 1;
    }
    // Corrida rara: outro processo criou o mesmo e-mail entre a checagem e a
    // escrita desta chamada. A transação já desfez a organização criada
    // aqui — nada ficou órfão no banco.
    if ((error as { code?: string }).code === DUPLICATE_KEY) {
      console.error('recusado: e-mail já em uso (corrida concorrente detectada). Nada foi alterado.');
      return 1;
    }
    throw error;
  }
}

const exitCode = await main();
await prisma.$disconnect();
process.exit(exitCode);
