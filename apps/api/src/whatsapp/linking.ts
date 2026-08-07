import { randomInt } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export const LINK_CODE_TTL_MINUTES = 15;

/** Alfabeto Crockford: sem I, L, O, U, 0 e 1 — nada que se confunda ao digitar. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 6;

export function generateLinkCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Uma mensagem só é candidata a código se for exatamente 6 chars do alfabeto. */
export function isLinkCodeMessage(text: string): boolean {
  return new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`).test(text.trim().toUpperCase());
}

export async function createLinkCode(
  prisma: PrismaClient,
  userId: string,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);
  await prisma.linkCode.create({ data: { code, userId, expiresAt } });
  return { code, expiresAt };
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'expired' | 'used' | 'phone_taken' };

export async function redeemLinkCode(
  prisma: PrismaClient,
  rawCode: string,
  phoneE164: string,
): Promise<RedeemResult> {
  const code = rawCode.trim().toUpperCase();

  const record = await prisma.linkCode.findUnique({
    where: { code },
    include: { user: { select: { id: true, organizationId: true } } },
  });

  if (!record) return { ok: false, reason: 'not_found' };
  if (record.usedAt) return { ok: false, reason: 'used' };
  if (record.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };

  // O telefone é único no schema; checamos antes para dar um erro compreensível
  // em vez de um P2002 do Prisma.
  const existing = await prisma.whatsAppIdentity.findUnique({ where: { phoneE164 } });
  if (existing && existing.userId !== record.userId) {
    return { ok: false, reason: 'phone_taken' };
  }

  await prisma.whatsAppIdentity.upsert({
    where: { userId: record.userId },
    create: {
      phoneE164, userId: record.userId,
      organizationId: record.user.organizationId,
      verifiedAt: new Date(),
    },
    update: { phoneE164, verifiedAt: new Date() },
  });

  await prisma.linkCode.update({ where: { code }, data: { usedAt: new Date() } });
  return { ok: true };
}
