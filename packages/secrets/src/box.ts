import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
/** 96 bits — o tamanho de IV recomendado para GCM; usar 128 bits reduz a segurança. */
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
export const CIPHERTEXT_FORMAT_VERSION = 'v1';

/**
 * Criptografia simétrica REVERSÍVEL para credenciais que o sistema precisa usar
 * de volta — ao contrário do `Pseudonymizer` (T3), que é de propósito
 * irreversível. Nunca use este pacote para dado pessoal do usuário final; use
 * para segredos operacionais (apiKey, secretKey) que o próprio sistema
 * apresenta a uma API terceira.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    if (!/^[0-9a-f]{64}$/i.test(hexKey)) {
      throw new Error('chave precisa ter 64 caracteres hexadecimais (32 bytes)');
    }
    this.key = Buffer.from(hexKey, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      CIPHERTEXT_FORMAT_VERSION,
      iv.toString('hex'),
      authTag.toString('hex'),
      ciphertext.toString('hex'),
    ].join('.');
  }

  decrypt(ciphertext: string): string {
    const parts = ciphertext.split('.');
    if (parts.length !== 4) {
      throw new Error(`texto cifrado inválido: formato esperado "v1.<iv>.<tag>.<dados>"`);
    }
    const [version, ivHex, authTagHex, dataHex] = parts as [string, string, string, string];
    if (version !== CIPHERTEXT_FORMAT_VERSION) {
      throw new Error(`versão de formato desconhecida: "${version}"`);
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    // Se a chave estiver errada ou o texto tiver sido adulterado, `final()`
    // lança — é a garantia de integridade do GCM, e propagamos o erro puro:
    // mascarar isso faria uma credencial corrompida parecer válida.
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }

  /** Atalho para campos opcionais do banco: `null` entra, `null` sai, sem lançar. */
  decryptOrNull(ciphertext: string | null): string | null {
    return ciphertext === null ? null : this.decrypt(ciphertext);
  }
}
