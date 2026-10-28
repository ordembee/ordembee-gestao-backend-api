import { createHmac } from 'crypto';
import {
  dropoffKey,
  manifestSize,
  mapDelivery,
  parseUberWebhook,
  toE164BR,
  toUberAddress,
  verifyUberSignature,
} from './uber-direct.util';

const addr = {
  cep: '20040020',
  street: 'Rua da Assembleia',
  number: '10',
  district: 'Centro',
  city: 'Rio de Janeiro',
  state: 'rj',
  complement: 'Sala 203',
};

describe('uber-direct.util', () => {
  it('telefone em E.164', () => {
    expect(toE164BR('21999999999')).toBe('+5521999999999');
    expect(toE164BR('(21) 3333-4444')).toBe('+552133334444');
    expect(toE164BR('+55 21 99999-9999')).toBe('+5521999999999');
    expect(toE164BR('5521999999999')).toBe('+5521999999999');
    expect(toE164BR('999')).toBeNull();
    expect(toE164BR('+1 415 555 0100')).toBeNull();
  });

  it('endereço no formato da Uber (string JSON)', () => {
    expect(JSON.parse(toUberAddress(addr))).toEqual({
      street_address: ['Rua da Assembleia, 10 - Centro', 'Sala 203'],
      city: 'Rio de Janeiro',
      state: 'RJ',
      zip_code: '20040-020',
      country: 'BR',
    });
  });

  it('dropoffKey ignora caixa, acento, espaços e complemento', () => {
    expect(dropoffKey(addr)).toBe(
      dropoffKey({
        ...addr,
        cep: '20040-020',
        street: 'rua  da assembléia',
        complement: undefined,
      }),
    );
    expect(dropoffKey(addr)).not.toBe(dropoffKey({ ...addr, number: '11' }));
  });

  it('assinatura do webhook: HMAC-SHA256 hex do corpo cru', () => {
    const body = Buffer.from('{"kind":"event.delivery_status"}');
    const sig = createHmac('sha256', 'chave').update(body).digest('hex');
    expect(verifyUberSignature(body, sig, 'chave')).toBe(true);
    expect(verifyUberSignature(body, sig.toUpperCase(), 'chave')).toBe(true);
    expect(verifyUberSignature(body, sig, 'outra')).toBe(false);
    expect(verifyUberSignature(body, undefined, 'chave')).toBe(false);
    expect(verifyUberSignature(body, 'zz', 'chave')).toBe(false);
  });

  it('lê delivery_status e courier_update', () => {
    expect(
      parseUberWebhook({
        kind: 'event.delivery_status',
        delivery_id: 'del_1',
        status: 'pickup',
        data: { id: 'del_1', status: 'pickup', courier: { name: 'Ana' } },
      }),
    ).toMatchObject({
      kind: 'event.delivery_status',
      deliveryId: 'del_1',
      status: 'pickup',
    });
    const courier = parseUberWebhook({
      kind: 'event.courier_update',
      data: { id: 'del_2' },
      location: { lat: -22.9, lng: -43.1 },
    });
    expect(courier).toMatchObject({
      deliveryId: 'del_2',
      location: { lat: -22.9, lng: -43.1 },
    });
    expect(parseUberWebhook('lixo').deliveryId).toBeNull();
    expect(
      parseUberWebhook({ delivery_id: 'x', status: 'inventado' }).status,
    ).toBeUndefined();
  });

  it('mapDelivery converte centavos e entregador', () => {
    const m = mapDelivery({
      status: 'dropoff',
      fee: 1490,
      tracking_url: 'https://t',
      dropoff_eta: '2026-10-22T20:00:00Z',
      courier: {
        name: 'Ana',
        phone_number: '+5521988887777',
        vehicle_type: 'motorcycle',
        rating: '4.9',
      },
    });
    expect(m).toMatchObject({
      status: 'dropoff',
      fee: 14.9,
      trackingUrl: 'https://t',
      courier: {
        name: 'Ana',
        phone: '+5521988887777',
        vehicleType: 'motorcycle',
        rating: 4.9,
      },
    });
    expect(m.dropoffEta?.toISOString()).toBe('2026-10-22T20:00:00.000Z');
  });

  it('até 10 unidades pede pacote pequeno (moto); acima, grande (carro)', () => {
    expect(manifestSize(1)).toBe('small');
    expect(manifestSize(10)).toBe('small');
    expect(manifestSize(11)).toBe('large');
  });
});
