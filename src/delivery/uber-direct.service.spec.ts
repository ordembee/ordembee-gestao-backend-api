import { createHmac } from 'crypto';
import { Types } from 'mongoose';
import { UberDirectService } from './uber-direct.service';
import { OrderStatus } from '../orders/schemas/order.schema';

const exec = (v: unknown) => ({ exec: () => Promise.resolve(v) });
const chain = (v: unknown) => ({
  select: () => ({ lean: () => exec(v) }),
});

const businessId = new Types.ObjectId();
const userId = new Types.ObjectId();
const SIGNING_KEY = 'chave-do-webhook';
const ID = new Types.ObjectId().toString();

function makeOrder(over: any = {}) {
  const order: any = {
    _id: new Types.ObjectId(),
    businessId,
    code: 42,
    status: OrderStatus.EM_PRODUCAO,
    total: 44.9,
    itemsTotal: 30,
    payments: [{ amount: 44.9 }],
    statusHistory: [],
    items: [{ productName: 'Bolo', quantity: 1, unitPrice: 30 }],
    delivery: {
      provider: 'UBER',
      quoteId: 'dqt_cliente',
      quotedFee: 14.9,
      dropoff: {
        cep: '20040020',
        street: 'Rua A',
        number: '1',
        district: 'Centro',
        city: 'Rio de Janeiro',
        state: 'RJ',
      },
      recipientName: 'João Pereira',
      recipientPhone: '+5521999999999',
      events: [],
    },
    save: jest.fn(async () => order),
    markModified: jest.fn(),
    ...over,
  };
  return order;
}

function setup(opts: { order?: any; quote?: any; uberFee?: number } = {}) {
  const order = opts.order ?? makeOrder();
  const uberSettings = {
    customerId: 'cust',
    clientId: 'cid',
    clientSecretEnc: 'x',
    pickupAddress: order.delivery.dropoff,
    pickupPhone: '+552133334444',
  };
  const businessModel = {
    findById: jest.fn(() =>
      chain({
        _id: businessId,
        name: 'Tia Naná',
        config: { uber: uberSettings },
      }),
    ),
    findOne: jest.fn(),
  };
  const orderModel = {
    findOne: jest.fn(() => exec(order)),
    updateOne: jest.fn(() => exec({ modifiedCount: 1 })),
  };
  const userModel = {
    findOne: jest.fn(() => exec({ _id: userId, displayName: 'Operador' })),
  };
  const quoteModel = {
    create: jest.fn(async (d: any) => d),
    findOne: jest.fn(() =>
      exec(
        opts.quote === undefined
          ? {
              quoteId: 'dqt_novo',
              fee: 14.9,
              expiresAt: new Date(Date.now() + 60_000),
            }
          : opts.quote,
      ),
    ),
  };
  const client = {
    createQuote: jest.fn(async () => ({
      id: 'dqt_novo',
      fee: Math.round((opts.uberFee ?? 14.9) * 100),
      expires: new Date(Date.now() + 15 * 60_000).toISOString(),
      duration: 35,
    })),
    createDelivery: jest.fn(async () => ({
      id: 'del_1',
      status: 'pending',
      fee: 1490,
      tracking_url: 'https://track',
    })),
    getDelivery: jest.fn(),
    cancelDelivery: jest.fn(),
  };
  const settings = {
    credentialsOf: jest.fn(() => ({
      customerId: 'cust',
      clientId: 'cid',
      clientSecret: 's',
    })),
    signingKeyOf: jest.fn(() => SIGNING_KEY),
  };
  const ordersService = {
    findOne: jest.fn(async () => ({ ok: true })),
    deliverAsUser: jest.fn(async () => ({})),
  };
  const service = new UberDirectService(
    businessModel as any,
    { findOne: jest.fn() } as any,
    orderModel as any,
    userModel as any,
    quoteModel as any,
    client as any,
    settings as any,
    ordersService as any,
  );
  return { service, order, client, quoteModel, orderModel, ordersService };
}

describe('UberDirectService — despacho', () => {
  it('recota e compara com o frete pago', async () => {
    const { service, quoteModel } = setup({ uberFee: 17.5 });
    const r = await service.requote(ID, businessId.toString());
    expect(r).toMatchObject({
      quoteId: 'dqt_novo',
      fee: 17.5,
      paidFee: 14.9,
      difference: 2.6,
      etaMinutes: 35,
    });
    expect(quoteModel.create.mock.calls[0][0].orderId).toBeDefined();
  });

  it('não despacha sem o Pix confirmado', async () => {
    const { service, client } = setup({ order: makeOrder({ payments: [] }) });
    await expect(service.requote(ID, businessId.toString())).rejects.toThrow(
      'confirmação do pagamento',
    );
    expect(client.createQuote).not.toHaveBeenCalled();
  });

  it('frete maior exige confirmação do operador', async () => {
    const { service, client } = setup({
      quote: {
        quoteId: 'dqt_novo',
        fee: 18,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      service.dispatch(ID, businessId.toString(), 'uid', 'dqt_novo'),
    ).rejects.toMatchObject({
      response: { reason: 'FEE_INCREASED', fee: 18, paidFee: 14.9 },
    });
    expect(client.createDelivery).not.toHaveBeenCalled();

    await service.dispatch(ID, businessId.toString(), 'uid', 'dqt_novo', true);
    expect(client.createDelivery).toHaveBeenCalled();
  });

  it('cotação vencida não despacha', async () => {
    const { service } = setup({
      quote: {
        quoteId: 'dqt_novo',
        fee: 14.9,
        expiresAt: new Date(Date.now() - 1),
      },
    });
    await expect(
      service.dispatch(ID, businessId.toString(), 'uid', 'dqt_novo'),
    ).rejects.toMatchObject({
      response: { reason: 'QUOTE_EXPIRED' },
    });
  });

  it('despacha com os dados do pedido e marca Pronto', async () => {
    const { service, client, order } = setup();
    await service.dispatch(ID, businessId.toString(), 'uid', 'dqt_novo');
    const req = (client.createDelivery.mock.calls[0] as any[])[1];
    expect(req).toMatchObject({
      quote_id: 'dqt_novo',
      pickup_name: 'Tia Naná',
      pickup_phone_number: '+552133334444',
      dropoff_name: 'João Pereira',
      dropoff_phone_number: '+5521999999999',
      manifest_total_value: 3000,
      dropoff_verification: { picture: true },
      manifest_items: [
        { name: 'Bolo', quantity: 1, size: 'small', price: 3000 },
      ],
    });
    expect(JSON.parse(req.dropoff_address).country).toBe('BR');
    expect(order.delivery).toMatchObject({
      uberDeliveryId: 'del_1',
      status: 'pending',
      fee: 14.9,
      trackingUrl: 'https://track',
    });
    expect(order.status).toBe(OrderStatus.PRONTO);
  });

  it('não pede dois entregadores', async () => {
    const order = makeOrder();
    order.delivery.status = 'pickup';
    const { service } = setup({ order });
    await expect(
      service.dispatch(ID, businessId.toString(), 'uid', 'dqt_novo'),
    ).rejects.toThrow('Já existe um entregador');
  });

  it('trava concorrente recusa o segundo clique', async () => {
    const { service, orderModel, client } = setup();
    orderModel.updateOne.mockReturnValueOnce(exec({ modifiedCount: 0 }) as any);
    await expect(
      service.dispatch(ID, businessId.toString(), 'uid', 'dqt_novo'),
    ).rejects.toThrow('já está sendo solicitada');
    expect(client.createDelivery).not.toHaveBeenCalled();
  });
});

describe('UberDirectService — webhook', () => {
  const sign = (raw: Buffer) =>
    createHmac('sha256', SIGNING_KEY).update(raw).digest('hex');
  const dispatched = (status = 'pending', over: any = {}) => {
    const order = makeOrder({ status: OrderStatus.PRONTO, ...over });
    Object.assign(order.delivery, {
      uberDeliveryId: 'del_1',
      status,
      requestedBy: userId,
    });
    return order;
  };

  it('recusa assinatura inválida', async () => {
    const { service } = setup({ order: dispatched() });
    const body = {
      kind: 'event.delivery_status',
      delivery_id: 'del_1',
      status: 'pickup',
    };
    await expect(
      service.handleWebhook(
        body,
        Buffer.from(JSON.stringify(body)),
        'f'.repeat(64),
      ),
    ).rejects.toThrow('Assinatura inválida');
  });

  it('atualiza status e entregador', async () => {
    const { service, order } = setup({ order: dispatched() });
    const body = {
      kind: 'event.delivery_status',
      delivery_id: 'del_1',
      status: 'pickup',
      data: {
        id: 'del_1',
        status: 'pickup',
        courier: {
          name: 'Ana',
          phone_number: '+5521988887777',
          vehicle_type: 'motorcycle',
        },
      },
    };
    const raw = Buffer.from(JSON.stringify(body));
    await service.handleWebhook(body, raw, sign(raw));
    expect(order.delivery.status).toBe('pickup');
    expect(order.delivery.courier).toMatchObject({
      name: 'Ana',
      vehicleType: 'motorcycle',
    });
    expect(order.delivery.events.at(-1)).toMatchObject({
      status: 'pickup',
      source: 'webhook',
    });
  });

  it('webhook atrasado não faz a corrida voltar', async () => {
    const { service, order } = setup({ order: dispatched('dropoff') });
    const body = {
      kind: 'event.delivery_status',
      delivery_id: 'del_1',
      status: 'pickup',
    };
    const raw = Buffer.from(JSON.stringify(body));
    await service.handleWebhook(body, raw, sign(raw));
    expect(order.delivery.status).toBe('dropoff');
  });

  it('entregue + pago conclui a encomenda (vira venda)', async () => {
    const { service, ordersService } = setup({ order: dispatched('dropoff') });
    const body = {
      kind: 'event.delivery_status',
      delivery_id: 'del_1',
      status: 'delivered',
    };
    const raw = Buffer.from(JSON.stringify(body));
    await service.handleWebhook(body, raw, sign(raw));
    expect(ordersService.deliverAsUser).toHaveBeenCalledWith(
      expect.any(String),
      businessId.toString(),
      userId,
      'Uber Direct',
    );
  });

  it('entregue sem pagamento confirmado fica para o operador', async () => {
    const { service, ordersService } = setup({
      order: dispatched('dropoff', { payments: [] }),
    });
    const body = {
      kind: 'event.delivery_status',
      delivery_id: 'del_1',
      status: 'delivered',
    };
    const raw = Buffer.from(JSON.stringify(body));
    await service.handleWebhook(body, raw, sign(raw));
    expect(ordersService.deliverAsUser).not.toHaveBeenCalled();
  });

  it('corrida desconhecida é ignorada sem erro', async () => {
    const { service, orderModel } = setup();
    orderModel.findOne.mockReturnValueOnce(exec(null) as any);
    await expect(
      service.handleWebhook(
        { delivery_id: 'del_x' },
        Buffer.from('{}'),
        undefined,
      ),
    ).resolves.toMatchObject({ ignored: 'corrida desconhecida' });
  });

  it('pedido com mais de 10 unidades vai como pacote grande (carro)', async () => {
    const order = makeOrder({
      items: [
        { productName: 'Bolo', quantity: 6, unitPrice: 5 },
        { productName: 'Torta', quantity: 5, unitPrice: 3 },
      ],
    });
    const { service, client } = setup({ order });
    await service.dispatch(ID, businessId.toString(), 'uid', 'dqt_novo');
    const req = (client.createDelivery.mock.calls[0] as any[])[1];
    expect(req.manifest_items.map((i: any) => i.size)).toEqual([
      'large',
      'large',
    ]);
  });
});
