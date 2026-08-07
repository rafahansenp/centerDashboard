import { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { UappiClient, UappiTokenProvider, MockUappiClient, type UappiClientLike, type UappiCredentials } from '@center/uappi-client';
import { loadConfig } from '../config.js';
import { syncAllOrganizations } from './scheduler.js';

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const pseudonymizer = new Pseudonymizer(config.piiPepper);
const secretBox = new SecretBox(config.credentialsEncryptionKey);

function buildClient(credentials: UappiCredentials): UappiClientLike {
  // MOCK_EXTERNAL_APIS=true (T4, T5B) ignora as credenciais e roda contra a
  // fixture — permite subir o sync sem apiKey/secretKey reais da Uappi.
  if (config.mockExternalApis) return new MockUappiClient();

  // Um token provider por organização: as credenciais são diferentes e o cache
  // de token não pode vazar entre lojas.
  const tokenProvider = new UappiTokenProvider({ baseUrl: config.uappiBaseUrl, credentials });
  return new UappiClient({ baseUrl: config.uappiBaseUrl, tokenProvider });
}

let running = false;

async function tick(): Promise<void> {
  // Trava simples: um ciclo longo (backfill) não pode disparar em cima de si mesmo.
  if (running) {
    console.warn('ciclo anterior ainda em execução, pulando este');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const report = await syncAllOrganizations({
      prisma, config, pseudonymizer, secretBox, buildClient,
      logger: (message, meta) => console.log(message, meta ?? ''),
    });
    console.log(`ciclo concluído em ${Date.now() - startedAt}ms`, report);
  } finally {
    running = false;
  }
}

const intervalMs = config.syncIntervalMinutes * 60_000;
console.log(`sync worker iniciado — intervalo de ${config.syncIntervalMinutes} minutos`);

await tick();
const timer = setInterval(() => void tick(), intervalMs);

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
