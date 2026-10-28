import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Cifra credenciais de terceiros (ex.: client_secret da Uber Direct) antes de
 * irem ao Mongo. AES-256-GCM com a chave de `CREDENTIALS_ENCRYPTION_KEY`
 * (64 caracteres hex = 32 bytes; gere com `openssl rand -hex 32`).
 *
 * Formato gravado: `v1.<iv>.<tag>.<cifrado>` (base64url). O prefixo de versao
 * deixa trocar o algoritmo/chave no futuro sem adivinhar o formato.
 */
const VERSION = 'v1';

export class SecretBoxError extends Error {}

function keyFrom(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new SecretBoxError(
      'CREDENTIALS_ENCRYPTION_KEY ausente ou inválida (precisa de 64 caracteres hex)',
    );
  }
  return Buffer.from(hex.trim(), 'hex');
}

export function encryptSecret(
  plain: string,
  keyHex = process.env.CREDENTIALS_ENCRYPTION_KEY,
): string {
  const key = keyFrom(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, data]
    .map((part) =>
      typeof part === 'string' ? part : part.toString('base64url'),
    )
    .join('.');
}

export function decryptSecret(
  boxed: string,
  keyHex = process.env.CREDENTIALS_ENCRYPTION_KEY,
): string {
  const key = keyFrom(keyHex);
  const [version, iv, tag, data] = String(boxed ?? '').split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) {
    throw new SecretBoxError('Credencial cifrada em formato desconhecido');
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Chave trocada ou dado adulterado: o GCM recusa.
    throw new SecretBoxError('Não foi possível decifrar a credencial');
  }
}

/** "abcd1234wxyz" -> "••••wxyz" — o que a tela mostra no lugar do segredo. */
export function maskSecret(plain: string): string {
  return plain.length <= 4 ? '••••' : `••••${plain.slice(-4)}`;
}
