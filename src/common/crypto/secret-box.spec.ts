import { decryptSecret, encryptSecret, maskSecret } from './secret-box';

const KEY = 'a'.repeat(64);

describe('secret-box', () => {
  it('cifra e decifra; o texto gravado nao contem o segredo', () => {
    const boxed = encryptSecret('meu-client-secret', KEY);
    expect(boxed.startsWith('v1.')).toBe(true);
    expect(boxed).not.toContain('meu-client-secret');
    expect(decryptSecret(boxed, KEY)).toBe('meu-client-secret');
  });

  it('cada cifragem usa IV novo', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('chave errada ou dado adulterado falham', () => {
    const boxed = encryptSecret('segredo', KEY);
    expect(() => decryptSecret(boxed, 'b'.repeat(64))).toThrow();
    const parts = boxed.split('.');
    parts[3] = Buffer.from('outro').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow();
  });

  it('sem chave configurada recusa', () => {
    expect(() => encryptSecret('x', '')).toThrow('CREDENTIALS_ENCRYPTION_KEY');
  });

  it('mascara', () => {
    expect(maskSecret('abcdefgh')).toBe('••••efgh');
  });
});
