import type { PrismaClient } from '@prisma/client';
import {
  LINK_CODE_TTL_MINUTES, createLinkCode, generateLinkCode, isLinkCodeMessage, redeemLinkCode,
} from '../whatsapp/linking.js';

function buildPrisma() {
  return {
    linkCode: {
      create: jest.fn(async ({ data }: { data: unknown }) => data),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
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
    expect(prisma.linkCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: 'A2B3C4' } }),
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
});
