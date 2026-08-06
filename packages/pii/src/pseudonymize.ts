import { createHmac } from 'node:crypto';

/** 32 hex = 128 bits. Suficiente contra colisão, curto para indexar no Postgres. */
export const PSEUDONYM_LENGTH = 32;

const MIN_PEPPER_LENGTH = 32;

/**
 * Converte dado pessoal em identificador determinístico e irreversível.
 *
 * HMAC-SHA256, não criptografia: a chave de join precisa ser determinística
 * (senão o join entre GA4 e pedido não fecha) E irreversível (não deve existir
 * chave capaz de recuperar o e-mail). Criptografia reversível falha no segundo
 * requisito. O pepper vive apenas em variável de ambiente, nunca no banco —
 * quem obtiver um dump do Postgres não consegue reverter nada.
 *
 * Trocar o pepper invalida todos os hashes já gravados. Isso é intencional: é o
 * mecanismo de revogação em caso de vazamento.
 */
export class Pseudonymizer {
  constructor(private readonly pepper: string) {
    if (pepper.length < MIN_PEPPER_LENGTH) {
      throw new Error(`PII_PEPPER precisa de ao menos ${MIN_PEPPER_LENGTH} caracteres`);
    }
  }

  /**
   * O namespace impede que o mesmo texto em papéis diferentes gere o mesmo
   * hash — sem ele, um CPF usado como senha de e-mail colidiria entre colunas.
   */
  hash(namespace: string, value: string): string {
    const normalized = value.trim();
    if (normalized === '') {
      throw new Error('valor vazio não pode ser pseudonimizado');
    }
    return createHmac('sha256', this.pepper)
      .update(`${namespace}:${normalized}`)
      .digest('hex')
      .slice(0, PSEUDONYM_LENGTH);
  }

  hashEmail(email: string): string {
    return this.hash('email', email.trim().toLowerCase());
  }

  /** CPF/CNPJ: só os dígitos importam; a formatação varia entre sistemas. */
  hashDocument(document: string): string {
    const digits = document.replace(/\D/g, '');
    if (digits === '') throw new Error('valor vazio não pode ser pseudonimizado');
    return this.hash('document', digits);
  }

  /** `client_id` do GA4, no formato `1234567890.1699999999`. */
  hashVisitorId(clientId: string): string {
    return this.hash('visitor', clientId);
  }
}
