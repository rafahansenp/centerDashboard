import { randomInt } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

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
  // Invalida qualquer código ainda não usado deste usuário antes de emitir um
  // novo. Sem isso, reloads/retries na tela de vínculo acumulam vários
  // códigos válidos ao mesmo tempo (até ~8, dado o rate limit de 5/10min
  // contra um TTL de 15min), o que aumenta proporcionalmente o espaço de
  // códigos adivinháveis num dado instante.
  await prisma.linkCode.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

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

  // Reivindica o código atomicamente ANTES de fazer qualquer outra coisa. O
  // `findUnique` acima é só leitura — sem isso, duas redenções concorrentes
  // do MESMO código (ex.: um invasor que descobriu o código correndo contra
  // o dono legítimo) passariam ambas pelas checagens acima antes de qualquer
  // uma marcar `usedAt`, e a que escrevesse por último venceria mesmo tendo
  // "perdido" a corrida — vinculando a conta a um telefone que não deveria.
  // Só o `updateMany` abaixo pode casar `usedAt: null`, então no máximo uma
  // chamada concorrente consegue `count === 1`.
  const claim = await prisma.linkCode.updateMany({
    where: { code, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });

  if (claim.count === 0) {
    // Perdemos a corrida (ou o código expirou entre a leitura e a tentativa
    // de reivindicação, uma janela de milissegundos). Reclassifica com uma
    // leitura fresca só para devolver o motivo certo ao chamador.
    const current = await prisma.linkCode.findUnique({ where: { code } });
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'used' };
  }

  // O telefone é único no schema; checamos antes para dar um erro
  // compreensível na maioria dos casos. Mas duas redenções concorrentes de
  // códigos DIFERENTES por usuários diferentes para o MESMO telefone ainda
  // podem passar por aqui antes de qualquer uma commitar — o catch abaixo é
  // o enforcement real; esta checagem é só uma otimização do caminho comum.
  const existing = await prisma.whatsAppIdentity.findUnique({ where: { phoneE164 } });
  if (existing && existing.userId !== record.userId) {
    return { ok: false, reason: 'phone_taken' };
  }

  try {
    await prisma.whatsAppIdentity.upsert({
      where: { userId: record.userId },
      create: {
        phoneE164, userId: record.userId,
        organizationId: record.user.organizationId,
        verifiedAt: new Date(),
      },
      update: { phoneE164, verifiedAt: new Date() },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { ok: false, reason: 'phone_taken' };
    }
    throw error;
  }

  return { ok: true };
}
