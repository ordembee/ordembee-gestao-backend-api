import {
  buildPixBrCode,
  crc16,
  isValidPixKey,
  normalizePixKey,
  pixText,
} from './pix-brcode';

describe('Pix BR Code', () => {
  it('CRC16 confere com o exemplo do manual do BR Code (Bacen)', () => {
    const example =
      '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304';
    expect(crc16(example)).toBe('1D3D');
  });

  it('monta o payload com valor, recebedor sem acento e txid', () => {
    const payload = buildPixBrCode({
      key: 'loja@exemplo.com',
      merchantName: 'Tia Naná Doces & Salgados',
      merchantCity: 'São João de Meriti',
      amount: 44.9,
      txid: 'PEDIDO-42',
    });
    expect(payload).toMatch(/^000201/);
    expect(payload).toContain('0014br.gov.bcb.pix0116loja@exemplo.com');
    expect(payload).toContain('540544.90');
    expect(payload).toContain('5802BR');
    expect(payload).toContain('5923TIA NANA DOCES SALGADOS');
    expect(payload).toContain('6015SAO JOAO DE MER');
    expect(payload).toContain('62120508PEDIDO42');
    expect(crc16(payload.slice(0, -4))).toBe(payload.slice(-4));
  });

  it('sem txid usa ***', () => {
    expect(
      buildPixBrCode({
        key: '12345678909',
        merchantName: 'A',
        merchantCity: 'B',
        amount: 1,
      }),
    ).toContain('62070503***');
  });

  it('normaliza e valida chaves', () => {
    expect(normalizePixKey(' 123.456.789-09 ')).toBe('12345678909');
    expect(normalizePixKey('+55 (21) 99999-9999')).toBe('+5521999999999');
    expect(normalizePixKey('Loja@Exemplo.com')).toBe('loja@exemplo.com');
    expect(isValidPixKey('12.345.678/0001-90')).toBe(true);
    expect(isValidPixKey('+5521999999999')).toBe(true);
    expect(isValidPixKey('123e4567-e12b-12d1-a456-426655440000')).toBe(true);
    expect(isValidPixKey('abc')).toBe(false);
    expect(isValidPixKey('123')).toBe(false);
  });

  it('pixText tira acento e corta', () => {
    expect(pixText('  Pão   de Açúcar ', 8)).toBe('PAO DE A');
  });
});
