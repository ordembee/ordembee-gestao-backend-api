import {
  buildLinkItems,
  methodOfCapture,
  normalizeHandle,
  parseLinkUrl,
  sumCents,
  toLinkAddress,
} from './infinitepay.util';

describe('infinitepay.util', () => {
  it('normalizeHandle tira o $ e espaços', () => {
    expect(normalizeHandle(' $tia-nana ')).toBe('tia-nana');
  });

  it('buildLinkItems soma exatamente o total do pedido (com complementos e taxa)', () => {
    const lines = buildLinkItems(
      [
        {
          productName: 'Bolo',
          quantity: 2,
          unitPrice: 31.1,
          options: [{ name: 'Cobertura' }],
        },
        { productName: 'Brigadeiro', quantity: 3, unitPrice: 2.55 },
      ],
      14.9,
    );
    expect(lines[0].description).toBe('Bolo (Cobertura)');
    expect(lines[lines.length - 1]).toMatchObject({
      price: 1490,
      description: 'Taxa de entrega',
    });
    expect(sumCents(lines)).toBe(2 * 3110 + 3 * 255 + 1490);
  });

  it('parseLinkUrl aceita as chaves prováveis e recusa não-https', () => {
    expect(parseLinkUrl({ url: 'https://x.io/a' })).toBe('https://x.io/a');
    expect(parseLinkUrl({ data: { checkout_url: 'https://x.io/b' } })).toBe(
      'https://x.io/b',
    );
    expect(parseLinkUrl({ url: 'http://x.io/a' })).toBeNull();
    expect(parseLinkUrl(null)).toBeNull();
  });

  it('toLinkAddress usa CEP só com dígitos e bairro como neighborhood', () => {
    expect(
      toLinkAddress({
        cep: '21616-170',
        street: 'Rua Brigada Belo',
        number: '10',
        district: 'Deodoro',
        complement: '',
      }),
    ).toEqual({
      cep: '21616170',
      street: 'Rua Brigada Belo',
      neighborhood: 'Deodoro',
      number: '10',
      complement: undefined,
    });
    expect(toLinkAddress(undefined)).toBeUndefined();
  });

  it('methodOfCapture', () => {
    expect(methodOfCapture('pix')).toBe('PIX');
    expect(methodOfCapture('credit_card')).toBe('CARTAO_CREDITO');
    expect(methodOfCapture('debit_card')).toBe('CARTAO_DEBITO');
    expect(methodOfCapture('boleto')).toBe('PAGAMENTO_ONLINE');
  });
});
