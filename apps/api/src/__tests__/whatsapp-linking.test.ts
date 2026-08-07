import { Prisma, type PrismaClient } from '@prisma/client';
import {
  LINK_CODE_TTL_MINUTES, createLinkCode, generateLinkCode, isLinkCodeMessage, redeemLinkCode,
} from '../whatsapp/linking.js';

function buildPrisma() {
  return {
    linkCode: {
      create: jest.fn(async ({ data }: { data: unknown }) => data),
      findUnique: jest.fn(async () => null),
      // Representa a reivindicação atômica de `redeemLinkCode` e a invalidação
      // de códigos anteriores em `createLinkCode`. Por padrão "ganha a
      // corrida" (count: 1); testes de concorrência sobrescrevem isso.
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    whatsAppIdentity: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
  } as unknown as PrismaClient;
}

describe('generateLinkCode', () => {
  it('produces six characters', () => {
    expect(generateLinkCode()).toHaveLength(6);
  });

  it('avoids ambiguous characters I, L, O, U and digits 0 and 1', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateLinkCode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    }
  });

  it('is not trivially repeating', () => {
    expect(new Set(Array.from({ length: 100 }, () => generateLinkCode())).size).toBeGreaterThan(90);
  });
});

describe('isLinkCodeMessage', () => {
  it('recognises a bare code', () => {
    expect(isLinkCodeMessage('A2B3C4')).toBe(true);
  });

  it('recognises a lowercase code with spaces', () => {
    expect(isLinkCodeMessage('  a2b3c4 ')).toBe(true);
  });

  it('does not treat a normal question as a code', () => {
    expect(isLinkCodeMessage('quanto vendemos mês passado?')).toBe(false);
  });

  it('does not treat a six letter word with invalid characters as a code', () => {
    expect(isLinkCodeMessage('ONIBUS')).toBe(false);
  });
});

describe('createLinkCode', () => {
  it('stores a code expiring in fifteen minutes', async () => {
    const prisma = buildPrisma();
    const before = Date.now();
    const result = await createLinkCode(prisma, 'user_1');
    const ttlMs = result.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan((LINK_CODE_TTL_MINUTES - 1) * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(LINK_CODE_TTL_MINUTES * 60_000 + 1000);
    expect(prisma.linkCode.create).toHaveBeenCalled();
  });

  it("invalidates the user's outstanding unused codes before issuing a new one", async () => {
    const prisma = buildPrisma();
    await createLinkCode(prisma, 'user_1');
    expect(prisma.linkCode.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    // A invalidação precisa acontecer antes de o novo código ser criado.
    const invalidateOrder = (prisma.linkCode.updateMany as jest.Mock).mock.invocationCallOrder[0];
    const createOrder = (prisma.linkCode.create as jest.Mock).mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeLessThan(createOrder);
  });
});

describe('redeemLinkCode', () => {
  const validCode = {
    code: 'A2B3C4', userId: 'user_1', usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: { id: 'user_1', organizationId: 'org_1' },
  };

  it('links the phone to the user on a valid code', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce(validCode);
    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777')).toEqual({ ok: true });
    expect(prisma.whatsAppIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_1' } }),
    );
    // A reivindicação é atômica: só casa (e marca usada) uma linha que ainda
    // esteja com `usedAt: null` e não expirada.
    expect(prisma.linkCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ code: 'A2B3C4', usedAt: null }),
        data: { usedAt: expect.any(Date) },
      }),
    );
  });

  it('accepts a lowercase code', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce(validCode);
    expect(await redeemLinkCode(prisma, 'a2b3c4', '+5511988887777')).toEqual({ ok: true });
  });

  it('rejects an unknown code', async () => {
    expect(await redeemLinkCode(buildPrisma(), 'ZZZZZZ', '+5511988887777'))
      .toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects an expired code', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce({
      ...validCode, expiresAt: new Date(Date.now() - 1000),
    });
    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777'))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a code that was already used', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce({ ...validCode, usedAt: new Date() });
    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777'))
      .toEqual({ ok: false, reason: 'used' });
  });

  it('rejects when the phone belongs to another user', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce(validCode);
    (prisma.whatsAppIdentity.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'wid_other', userId: 'user_outro',
    });
    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777'))
      .toEqual({ ok: false, reason: 'phone_taken' });
    expect(prisma.whatsAppIdentity.upsert).not.toHaveBeenCalled();
  });

  // --- Corridas: duas redenções concorrentes do mesmo código ---
  //
  // O mock não é um banco real, então simulamos o resultado que o Postgres
  // garantiria (só uma linha casa `usedAt: null` por vez) controlando
  // diretamente o retorno do `updateMany` — é a forma de exercitar, num
  // teste unitário single-threaded, o comportamento que a query atômica
  // produziria sob concorrência real.
  it('treats a lost race for the same code as already used, without touching the identity', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock)
      // Leitura inicial: código ainda parece válido.
      .mockResolvedValueOnce(validCode)
      // Reclassificação após perder a corrida: outra requisição concorrente
      // já marcou `usedAt` entre nossa leitura e nossa tentativa de reivindicar.
      .mockResolvedValueOnce({ ...validCode, usedAt: new Date() });
    (prisma.linkCode.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777'))
      .toEqual({ ok: false, reason: 'used' });
    expect(prisma.whatsAppIdentity.upsert).not.toHaveBeenCalled();
  });

  it('reclassifies as expired when the claim window closes between read and claim', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock)
      .mockResolvedValueOnce(validCode)
      .mockResolvedValueOnce({ ...validCode, expiresAt: new Date(Date.now() - 1000) });
    (prisma.linkCode.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777'))
      .toEqual({ ok: false, reason: 'expired' });
  });

  // --- Corrida: dois códigos DIFERENTES (usuários diferentes) redimidos
  // concorrentemente para o MESMO telefone ---
  //
  // A checagem prévia (`whatsAppIdentity.findUnique`) é só uma otimização do
  // caminho comum: sob concorrência real, as duas chamadas podem ler `null`
  // antes de qualquer commit, e o INSERT subjacente de uma delas colide com
  // a constraint `phoneE164 @unique`. O Prisma expõe isso como um
  // `PrismaClientKnownRequestError` de código P2002.
  it('maps a concurrent unique-constraint violation on the phone to phone_taken instead of throwing', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce(validCode);
    (prisma.whatsAppIdentity.upsert as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`phoneE164`)', {
        code: 'P2002', clientVersion: '6.1.0',
      }),
    );

    await expect(redeemLinkCode(prisma, 'A2B3C4', '+5511988887777'))
      .resolves.toEqual({ ok: false, reason: 'phone_taken' });
  });

  it('re-throws unrelated errors from the identity upsert instead of swallowing them', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce(validCode);
    (prisma.whatsAppIdentity.upsert as jest.Mock).mockRejectedValueOnce(new Error('conexão perdida'));

    await expect(redeemLinkCode(prisma, 'A2B3C4', '+5511988887777')).rejects.toThrow('conexão perdida');
  });
});
