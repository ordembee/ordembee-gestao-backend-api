/**
 * Pix "copia e cola" estatico (BR Code, padrao EMV-QRCPS do Banco Central)
 * com valor fixo. Nao ha PSP nem confirmacao automatica: o cliente paga pelo
 * app do banco e a loja confere o extrato (decisao do produto).
 */

export interface PixBrCodeInput {
  /** Chave Pix da loja: CPF/CNPJ (so digitos), e-mail, +55DDDNUMERO ou aleatoria (EVP). */
  key: string;
  /** Nome do recebedor (ate 25 caracteres, sem acento). */
  merchantName: string;
  /** Cidade do recebedor (ate 15 caracteres, sem acento). */
  merchantCity: string;
  /** Valor em reais. */
  amount: number;
  /** Identificador que aparece no extrato (ate 25, so [A-Za-z0-9]). '***' = sem id. */
  txid?: string;
  /** Mensagem ao pagador (vai junto com a chave; nem todo banco mostra). */
  description?: string;
}

const field = (id: string, value: string) =>
  `${id}${String(value.length).padStart(2, '0')}${value}`;

/** Remove acento e o que o padrao nao aceita; corta no tamanho maximo. */
export function pixText(value: string, max: number): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,\-@/]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .toUpperCase();
}

/** CRC16-CCITT (poly 0x1021, init 0xFFFF) exigido no campo 63. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Normaliza a chave como o DICT espera (telefone com +55, documento so digitos). */
export function normalizePixKey(raw: string): string {
  const key = raw.trim();
  if (key.includes('@')) return key.toLowerCase();
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
  ) {
    return key.toLowerCase();
  }
  if (key.startsWith('+')) return `+${key.replace(/\D/g, '')}`;
  return key.replace(/\D/g, '');
}

export function isValidPixKey(raw: string): boolean {
  const key = normalizePixKey(raw ?? '');
  return (
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key) || // e-mail
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      key,
    ) || // aleatoria
    /^\+55\d{10,11}$/.test(key) || // telefone
    /^\d{11}$/.test(key) || // CPF
    /^\d{14}$/.test(key) // CNPJ
  );
}

export function buildPixBrCode(input: PixBrCodeInput): string {
  const key = normalizePixKey(input.key);
  const description = input.description ? pixText(input.description, 40) : '';
  const account =
    field('00', 'br.gov.bcb.pix') +
    field('01', key) +
    (description ? field('02', description) : '');
  const txid =
    (input.txid ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';

  const payload =
    field('00', '01') + // formato
    field('26', account) +
    field('52', '0000') + // categoria do comerciante
    field('53', '986') + // BRL
    field('54', input.amount.toFixed(2)) +
    field('58', 'BR') +
    field('59', pixText(input.merchantName, 25) || 'LOJA') +
    field('60', pixText(input.merchantCity, 15) || 'BRASIL') +
    field('62', field('05', txid)) +
    '6304';
  return payload + crc16(payload);
}
