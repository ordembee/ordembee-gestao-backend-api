import { Types } from 'mongoose';
import { PanelCheckoutService } from './panel-checkout.service';
import { dropoffKey } from '../delivery/uber-direct.util';

const businessId = new Types.ObjectId();
const address = {
  cep: '22000-000',
  street: 'Rua A',
  number: '10',
  district: 'Centro',
  city: 'Rio',
  state: 'RJ',
};

const exec = (v: unknown) => ({ exec: () => Promise.resolve(v) });

function setup(
  over: { uber?: boolean; infinitePay?: boolean; quote?: object | null } = {},
) {
  const uberCfg =
    over.uber === false
      ? undefined
      : {
          customerId: 'c',
          clientId: 'i',
          clientSecretEnc: 'x',
          pickupAddress: address,
          pickupPhone: '+5521999999999',
        };
  const businessModel = {
    findById: jest.fn(() => ({
      select: () => ({ lean: () => exec({ config: { uber: uberCfg } }) }),
    })),
  };
  const quote =
    over.quote === undefined
      ? {
          quoteId: 'q1',
          fee: 12.5,
          expiresAt: new Date(Date.now() + 600_000),
          dropoffKey: dropoffKey(address),
        }
      : over.quote;
  const menuModel = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () =>
          exec({
            store: {
              delivery: { deliveryProvider: 'UBER', deliveryEnabled: true },
            },
          }),
      }),
    })),
  };
  const quoteModel = {
    findOne: jest.fn(() => exec(quote)),
    updateOne: jest.fn(() => exec({})),
  };
  const infinitePay = {
    isActive: jest.fn(async () => over.infinitePay !== false),
    ensureCheckoutById: jest.fn(async () => ({ checkoutUrl: 'https://x' })),
  };
  const service = new PanelCheckoutService(
    businessModel as any,
    menuModel as any,
    quoteModel as any,
    infinitePay as any,
  );
  return { service, quoteModel, infinitePay };
}

const uberDto = (over: object = {}): any => ({
  fulfillment: 'ENTREGA',
  uberDelivery: {
    quoteId: 'q1',
    address,
    recipientName: 'Maria Silva',
    recipientPhone: '(21) 99999-9999',
    ...over,
  },
});

describe('PanelCheckoutService.prepare', () => {
  it('sem Uber nem InfinitePay não acrescenta nada', async () => {
    const { service } = setup();
    expect(await service.prepare(businessId.toString(), {} as any)).toEqual({});
  });

  it('entrega Uber: o frete vem da cotação guardada', async () => {
    const { service } = setup();
    const extras = await service.prepare(businessId.toString(), uberDto());
    expect(extras.delivery).toMatchObject({
      provider: 'UBER',
      quoteId: 'q1',
      quotedFee: 12.5,
      recipientPhone: '+5521999999999',
    });
  });

  it('recusa cotação de outro endereço, expirada ou inexistente', async () => {
    const other = { ...address, number: '99' };
    await expect(
      setup().service.prepare(
        businessId.toString(),
        uberDto({ address: other }),
      ),
    ).rejects.toMatchObject({ response: { reason: 'QUOTE_MISMATCH' } });
    await expect(
      setup({ quote: null }).service.prepare(businessId.toString(), uberDto()),
    ).rejects.toMatchObject({ response: { reason: 'QUOTE_MISMATCH' } });
    await expect(
      setup({
        quote: {
          quoteId: 'q1',
          fee: 1,
          expiresAt: new Date(Date.now() - 1000),
          dropoffKey: dropoffKey(address),
        },
      }).service.prepare(businessId.toString(), uberDto()),
    ).rejects.toMatchObject({ response: { reason: 'QUOTE_EXPIRED' } });
  });

  it('exige modo Entrega, Uber configurada e nome com sobrenome', async () => {
    await expect(
      setup().service.prepare(businessId.toString(), {
        ...uberDto(),
        fulfillment: 'RETIRADA',
      }),
    ).rejects.toThrow('modo Entrega');
    await expect(
      setup({ uber: false }).service.prepare(businessId.toString(), uberDto()),
    ).rejects.toThrow('não está configurada');
    await expect(
      setup().service.prepare(
        businessId.toString(),
        uberDto({ recipientName: 'Maria' }),
      ),
    ).rejects.toThrow('sobrenome');
  });

  it('InfinitePay: exige a integração ativa e não combina com pagamento já recebido', async () => {
    const { service } = setup();
    const extras = await service.prepare(businessId.toString(), {
      infinitePay: { amount: 30 },
    } as any);
    expect(extras.infinitePay?.amount).toBe(30);
    expect(extras.infinitePay?.orderNsu).toMatch(/^[0-9a-f-]{36}$/);

    await expect(
      setup({ infinitePay: false }).service.prepare(businessId.toString(), {
        infinitePay: {},
      } as any),
    ).rejects.toThrow('não está habilitada');
    await expect(
      service.prepare(businessId.toString(), {
        infinitePay: {},
        payments: [{ method: 'PIX', amount: 10 }],
      } as any),
    ).rejects.toThrow('não os dois');
  });
});

describe('PanelCheckoutService.options', () => {
  it('Uber vale quando a loja escolheu a Uber e as credenciais estão prontas', async () => {
    const { service } = setup();
    expect(await service.options(businessId.toString())).toMatchObject({
      uber: true,
      ownDelivery: false,
      pickup: true,
    });
    const noUber = await setup({ uber: false }).service.options(
      businessId.toString(),
    );
    expect(noUber.uber).toBe(false);
  });
});

describe('PanelCheckoutService.finish', () => {
  it('prende a cotação ao pedido e gera o link; falha no link não derruba', async () => {
    const { service, quoteModel, infinitePay } = setup();
    infinitePay.ensureCheckoutById.mockRejectedValueOnce(new Error('fora'));
    const order = { _id: new Types.ObjectId(), code: 3 };
    await service.finish(order, businessId.toString(), {
      delivery: { quoteId: 'q1' } as any,
      infinitePay: { orderNsu: 'n' },
    });
    expect(quoteModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: 'q1' }),
      { $set: { orderId: order._id } },
    );
    expect(infinitePay.ensureCheckoutById).toHaveBeenCalled();
  });
});
