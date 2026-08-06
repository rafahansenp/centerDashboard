import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3333),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de ao menos 32 caracteres'),
  PII_PEPPER: z.string().min(32, 'PII_PEPPER precisa de ao menos 32 caracteres'),
  // 32 bytes em hex — exatamente o que AES-256-GCM exige. Gere com `openssl rand -hex 32`.
  CREDENTIALS_ENCRYPTION_KEY: z.string().regex(
    /^[0-9a-f]{64}$/i, 'CREDENTIALS_ENCRYPTION_KEY precisa ter 64 caracteres hexadecimais (32 bytes)',
  ),
  ANTHROPIC_API_KEY: z.string().min(1),
  UAPPI_BASE_URL: z.string().url(),
  GA4_CREDENTIALS_JSON: z.string().default(''),
  // Piso de 10 min protege a cota da Uappi contra um typo na configuração.
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(10, 'SYNC_INTERVAL_MINUTES mínimo é 10').default(30),
  SYNC_BACKFILL_DAYS: z.coerce.number().int().min(1).max(730).default(90),
  // z.coerce.boolean() trataria QUALQUER string não vazia como true — inclusive
  // a string "false". Por isso a comparação explícita: só a literal "true" vira
  // true, qualquer outra coisa (inclusive lixo) vira false.
  MOCK_EXTERNAL_APIS: z.string().default('false').transform((v) => v === 'true'),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
});

export interface AppConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  piiPepper: string;
  credentialsEncryptionKey: string;
  anthropicApiKey: string;
  uappiBaseUrl: string;
  ga4CredentialsJson: string;
  syncIntervalMinutes: number;
  syncBackfillDays: number;
  mockExternalApis: boolean;
  whatsapp: {
    appSecret: string;
    verifyToken: string;
    accessToken: string;
    phoneNumberId: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuração inválida — ${details}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    jwtSecret: e.JWT_SECRET,
    piiPepper: e.PII_PEPPER,
    credentialsEncryptionKey: e.CREDENTIALS_ENCRYPTION_KEY,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    uappiBaseUrl: e.UAPPI_BASE_URL,
    ga4CredentialsJson: e.GA4_CREDENTIALS_JSON,
    syncIntervalMinutes: e.SYNC_INTERVAL_MINUTES,
    syncBackfillDays: e.SYNC_BACKFILL_DAYS,
    mockExternalApis: e.MOCK_EXTERNAL_APIS,
    whatsapp: {
      appSecret: e.WHATSAPP_APP_SECRET,
      verifyToken: e.WHATSAPP_VERIFY_TOKEN,
      accessToken: e.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
    },
  };
}
