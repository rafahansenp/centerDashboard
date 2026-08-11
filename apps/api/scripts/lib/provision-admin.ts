import { z } from 'zod';
import { hashPassword } from '../../src/auth/password.js';

// Mesmo padrão de src/config.ts: Zod schema + safeParse + mensagem agregada
// com todos os erros, não só o primeiro.
const ProvisionEnvSchema = z.object({
  PROVISION_ORG_NAME: z.string().min(1, 'PROVISION_ORG_NAME é obrigatório'),
  PROVISION_ADMIN_NAME: z.string().min(1, 'PROVISION_ADMIN_NAME é obrigatório'),
  PROVISION_ADMIN_EMAIL: z.string().email('PROVISION_ADMIN_EMAIL precisa ser um e-mail válido'),
  // Sem valor padrão, sem fallback: o operador sempre informa a senha do
  // primeiro admin. 12 caracteres — o dobro do mínimo já usado em outros
  // segredos do projeto (JWT_SECRET/PII_PEPPER exigem 32, mas são chaves
  // geradas, não senhas memorizadas por humano).
  PROVISION_ADMIN_PASSWORD: z.string().min(12, 'PROVISION_ADMIN_PASSWORD precisa de ao menos 12 caracteres'),
});

export type ProvisionInput = z.infer<typeof ProvisionEnvSchema>;

export function parseProvisionEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ProvisionInput {
  const parsed = ProvisionEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuração de provisionamento inválida — ${details}`);
  }
  return parsed.data;
}

/** Lançada quando o banco já tem usuário(s) — recusa deliberada, nunca upsert. */
export class ProvisionRefusedError extends Error {}

interface ProvisionTx {
  user: {
    count(): Promise<number>;
    create(args: {
      data: { email: string; name: string; role: 'ADMIN'; passwordHash: string; organizationId: string };
    }): Promise<{ id: string; email: string }>;
  };
  organization: {
    create(args: { data: { name: string } }): Promise<{ id: string; name: string }>;
  };
}

export interface ProvisionPrisma {
  $transaction<T>(fn: (tx: ProvisionTx) => Promise<T>): Promise<T>;
}

export interface ProvisionOutcome {
  organizationId: string;
  organizationName: string;
  userId: string;
  email: string;
}

/**
 * Provisiona a primeira organização + o primeiro admin de uma instalação.
 *
 * Conservador por design: se JÁ existe qualquer usuário no banco, recusa
 * (lança `ProvisionRefusedError`) em vez de fazer upsert. Um script que
 * "toma conta" silenciosamente de uma instalação existente é perigoso — rodar
 * duas vezes, ou apontar sem querer para o banco errado, nunca deve trocar a
 * senha de um admin já em uso nem criar uma segunda organização por engano.
 * Isso também cobre a corrida de e-mail duplicado (P2002): a checagem e as
 * duas escritas rodam dentro da mesma transação, então qualquer falha (a
 * recusa por count>0, lançada ANTES de qualquer escrita, ou um P2002 vindo da
 * escrita concorrente de outro processo) desfaz a organização já criada nesta
 * chamada — nunca fica um registro órfão no ar.
 */
export async function provisionFirstAdmin(
  prisma: ProvisionPrisma,
  input: ProvisionInput,
): Promise<ProvisionOutcome> {
  return prisma.$transaction(async (tx) => {
    const existingUsers = await tx.user.count();
    if (existingUsers > 0) {
      throw new ProvisionRefusedError(
        `já existem ${existingUsers} usuário(s) no banco — este script só provisiona a primeira `
          + 'instalação (banco vazio). Nada foi alterado.',
      );
    }

    const organization = await tx.organization.create({ data: { name: input.PROVISION_ORG_NAME } });
    const user = await tx.user.create({
      data: {
        email: input.PROVISION_ADMIN_EMAIL,
        name: input.PROVISION_ADMIN_NAME,
        role: 'ADMIN',
        passwordHash: await hashPassword(input.PROVISION_ADMIN_PASSWORD),
        organizationId: organization.id,
      },
    });

    return {
      organizationId: organization.id,
      organizationName: organization.name,
      userId: user.id,
      email: user.email,
    };
  });
}
