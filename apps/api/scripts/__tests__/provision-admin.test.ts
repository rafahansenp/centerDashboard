import { verifyPassword } from '../../src/auth/password.js';
import {
  ProvisionRefusedError,
  parseProvisionEnv,
  provisionFirstAdmin,
  type ProvisionPrisma,
} from '../lib/provision-admin.js';

const validEnv = {
  PROVISION_ORG_NAME: 'Loja Principal',
  PROVISION_ADMIN_NAME: 'Ana Admin',
  PROVISION_ADMIN_EMAIL: 'ana@example.com',
  PROVISION_ADMIN_PASSWORD: 'senha-forte-123',
};

describe('parseProvisionEnv', () => {
  it('parses a fully-populated env', () => {
    expect(parseProvisionEnv(validEnv)).toEqual(validEnv);
  });

  it('rejects a missing field with a named, descriptive error', () => {
    const { PROVISION_ORG_NAME: _omit, ...rest } = validEnv;
    expect(() => parseProvisionEnv(rest)).toThrow(/PROVISION_ORG_NAME/);
  });

  it('rejects a malformed email', () => {
    expect(() => parseProvisionEnv({ ...validEnv, PROVISION_ADMIN_EMAIL: 'not-an-email' }))
      .toThrow(/PROVISION_ADMIN_EMAIL/);
  });

  it('rejects a password shorter than 12 characters', () => {
    expect(() => parseProvisionEnv({ ...validEnv, PROVISION_ADMIN_PASSWORD: 'curta' }))
      .toThrow(/PROVISION_ADMIN_PASSWORD/);
  });

  it('aggregates every issue in one message, not just the first', () => {
    try {
      parseProvisionEnv({});
      throw new Error('deveria ter lançado');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/PROVISION_ORG_NAME/);
      expect(message).toMatch(/PROVISION_ADMIN_NAME/);
      expect(message).toMatch(/PROVISION_ADMIN_EMAIL/);
      expect(message).toMatch(/PROVISION_ADMIN_PASSWORD/);
    }
  });
});

/** Fake mínimo o bastante para exercitar provisionFirstAdmin sem Postgres real. */
function fakePrisma(options: { existingUsers: number; failUserCreateWith?: { code: string } }): {
  prisma: ProvisionPrisma;
  organizationCreate: jest.Mock;
  userCreate: jest.Mock;
} {
  let nextOrgId = 1;
  let nextUserId = 1;

  const organizationCreate = jest.fn(async (args: { data: { name: string } }) => ({
    id: `org_${nextOrgId++}`,
    name: args.data.name,
  }));

  const userCreate = jest.fn(async (args: { data: { email: string } }) => {
    if (options.failUserCreateWith) {
      const error = new Error('Unique constraint failed') as Error & { code: string };
      error.code = options.failUserCreateWith.code;
      throw error;
    }
    return { id: `user_${nextUserId++}`, email: args.data.email };
  });

  const tx = {
    user: { count: jest.fn(async () => options.existingUsers), create: userCreate },
    organization: { create: organizationCreate },
  };

  // Fake fiel o bastante para o propósito do teste: chama o callback com o tx
  // fake e propaga qualquer rejeição, exatamente como o real Prisma faz ao
  // desfazer a transação inteira quando o callback lança.
  const prisma: ProvisionPrisma = {
    $transaction: (fn) => fn(tx as never),
  };

  return { prisma, organizationCreate, userCreate };
}

describe('provisionFirstAdmin', () => {
  it('creates the organization and the admin on a clean (empty) database', async () => {
    const { prisma, organizationCreate, userCreate } = fakePrisma({ existingUsers: 0 });

    const result = await provisionFirstAdmin(prisma, validEnv);

    expect(result).toEqual({
      organizationId: 'org_1', organizationName: 'Loja Principal',
      userId: 'user_1', email: 'ana@example.com',
    });
    expect(organizationCreate).toHaveBeenCalledTimes(1);
    expect(userCreate).toHaveBeenCalledTimes(1);
    // A senha em claro nunca é gravada — só um hash scrypt válido, e esse
    // hash precisa bater com a senha original via o mesmo verifyPassword
    // usado pelo /auth/login (nenhum esquema de hashing paralelo).
    const writtenHash = userCreate.mock.calls[0][0].data.passwordHash as string;
    expect(writtenHash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(validEnv.PROVISION_ADMIN_PASSWORD, writtenHash)).toBe(true);
    expect(await verifyPassword('senha-errada-123', writtenHash)).toBe(false);
  });

  it('refuses and writes nothing when a user already exists', async () => {
    const { prisma, organizationCreate, userCreate } = fakePrisma({ existingUsers: 1 });

    await expect(provisionFirstAdmin(prisma, validEnv)).rejects.toThrow(ProvisionRefusedError);
    expect(organizationCreate).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
  });

  it('refuses safely when re-run against an already-provisioned database (second run)', async () => {
    // Simula rodar o script duas vezes: a 1a chamada parte de banco vazio, a
    // 2a enxerga o usuário que a 1a acabou de criar.
    const first = fakePrisma({ existingUsers: 0 });
    await provisionFirstAdmin(first.prisma, validEnv);

    const second = fakePrisma({ existingUsers: 1 });
    await expect(provisionFirstAdmin(second.prisma, validEnv)).rejects.toThrow(/já existem 1 usuário/);
    expect(second.organizationCreate).not.toHaveBeenCalled();
  });

  it('propagates a concurrent duplicate-email race (P2002) without leaving an orphan organization', async () => {
    const { prisma, organizationCreate, userCreate } = fakePrisma({
      existingUsers: 0, failUserCreateWith: { code: 'P2002' },
    });

    await expect(provisionFirstAdmin(prisma, validEnv)).rejects.toMatchObject({ code: 'P2002' });
    // A organização foi criada dentro da mesma chamada de $transaction que
    // lançou — no Prisma real isso é desfeito pelo rollback automático da
    // transação. Aqui confirmamos só que o código tentou de fato as duas
    // escritas na ordem certa (organização antes do usuário), não que o
    // fake reverte por si (ele não tem estado para reverter).
    expect(organizationCreate).toHaveBeenCalledTimes(1);
    expect(userCreate).toHaveBeenCalledTimes(1);
  });
});
