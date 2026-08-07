import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';
const DIGEST_HEX_LENGTH = 64;

export function signPayload(rawBody: Buffer, appSecret: string): string {
  return `${PREFIX}${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/**
 * Valida o header X-Hub-Signature-256 — a única fronteira que impede um
 * terceiro de disparar o agente às nossas custas. Todo caminho de erro devolve
 * `false`; esta função nunca lança.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith(PREFIX)) return false;

  const received = header.slice(PREFIX.length);
  if (received.length !== DIGEST_HEX_LENGTH || !/^[0-9a-f]+$/i.test(received)) return false;

  // Comparação em tempo constante: evita distinguir assinaturas por timing.
  return timingSafeEqual(
    Buffer.from(received, 'hex'),
    createHmac('sha256', appSecret).update(rawBody).digest(),
  );
}
