import { Types } from 'mongoose';
import { InfinitePayApiError } from './infinitepay.client';
import { InfinitePayService } from './infinitepay.service';

const businessId = new Types.ObjectId();

function setup(over: { order?: any; check?: any; checkError?: Error } = {}) {
  const order: any = over.order ?? {
    _id: new Types.ObjectId(),
    code: 7,
    businessId,
    total: 44.9,
    status: 'PENDENTE',
    requestedPayment: { prepaid: true },
    infinitePay: { orderNsu: 'ref-1' },
  };
  const exec = (v: unknown) => ({ exec: () => Promise.resolve(v) });
  const orderModel = {
    findOne: jest.fn(() => exec(order)),
    findById: jest.fn(() => exec(order)),
    updateOne: jest.fn(() => exec({ modifiedCount: 1 })),
  };
  const lean = (v: unknown) => ({ select: () => ({ lean: () => exec(v) }) });
  const businessModel = {
    findById: jest.fn(() =>
      lean({ config: { infinitepay: { handle: 'loja', enabled: true } } }),
    ),
  };
  const client = {
    paymentCheck: jest.fn(async () => {
      if (over.checkError) throw over.checkError;
      return (
        over.check ?? {
          success: true,
          paid: true,
          amount: 4490,
          paid_amount: 4490,
          installments: 1,
          capture_method: 'pix',
        }
      );
    }),
    createLink: jest.fn(),
  };
  const service = new InfinitePayService(
    orderModel as any,
    businessModel as any,
    { findOne: jest.fn() } as any,
    client as any,
  );
  return { service, orderModel, client, order };
}

describe('InfinitePayService.handleWebhook', () => {
  it('confirma consultando a InfinitePay e lança o pagamento no total do pedido', async () => {
    const { service, orderModel, client } = setup();
    const res = await service.handleWebhook({
      order_nsu: 'ref-1',
      transaction_nsu: 'tx-1',
      invoice_slug: 'inv-1',
    });
    expect(res).toEqual({ ok: true, paid: true });
    expect(client.paymentCheck).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'loja', order_nsu: 'ref-1' }),
    );
    const update = (orderModel.updateOne.mock.calls[0] as any[])[1];
    expect(update.$push.payments).toMatchObject({
      method: 'PIX',
      amount: 44.9,
    });
    expect(update.$set['infinitePay.transactionNsu']).toBe('tx-1');
  });

  it('webhook falso (consulta diz não pago) não confirma nada', async () => {
    const { service, orderModel } = setup({
      check: { success: true, paid: false },
    });
    const res = await service.handleWebhook({
      order_nsu: 'ref-1',
      transaction_nsu: 'tx-1',
      invoice_slug: 'inv-1',
    });
    expect(res.paid).toBe(false);
    expect(orderModel.updateOne).not.toHaveBeenCalled();
  });

  it('valor diferente do pedido não confirma', async () => {
    const { service, orderModel } = setup({
      check: { paid: true, amount: 100, capture_method: 'pix' },
    });
    expect(
      (
        await service.handleWebhook({
          order_nsu: 'ref-1',
          transaction_nsu: 'tx-1',
          invoice_slug: 'inv-1',
        })
      ).paid,
    ).toBe(false);
    expect(orderModel.updateOne).not.toHaveBeenCalled();
  });

  it('já pago: não consulta nem lança de novo', async () => {
    const { service, orderModel, client } = setup({
      order: {
        _id: new Types.ObjectId(),
        businessId,
        total: 10,
        infinitePay: { orderNsu: 'ref-1', paidAt: new Date() },
      },
    });
    expect(
      (
        await service.handleWebhook({
          order_nsu: 'ref-1',
          transaction_nsu: 'tx-1',
          invoice_slug: 'inv-1',
        })
      ).paid,
    ).toBe(true);
    expect(client.paymentCheck).not.toHaveBeenCalled();
    expect(orderModel.updateOne).not.toHaveBeenCalled();
  });

  it('cartão de crédito vira CARTAO_CREDITO; juros do parcelamento ficam fora do valor', async () => {
    const { service, orderModel } = setup({
      check: {
        paid: true,
        amount: 4490,
        paid_amount: 4700,
        installments: 3,
        capture_method: 'credit_card',
      },
    });
    await service.handleWebhook({
      order_nsu: 'ref-1',
      transaction_nsu: 'tx-1',
      invoice_slug: 'inv-1',
    });
    const update = (orderModel.updateOne.mock.calls[0] as any[])[1];
    expect(update.$push.payments).toMatchObject({
      method: 'CARTAO_CREDITO',
      amount: 44.9,
    });
    expect(update.$set['infinitePay.paidAmount']).toBe(47);
  });

  it('pedido cancelado que foi pago registra o pagamento no bloco, mas não em payments', async () => {
    const { service, orderModel } = setup({
      order: {
        _id: new Types.ObjectId(),
        code: 1,
        businessId,
        total: 44.9,
        status: 'CANCELADA',
        infinitePay: { orderNsu: 'ref-1' },
      },
    });
    await service.handleWebhook({
      order_nsu: 'ref-1',
      transaction_nsu: 'tx-1',
      invoice_slug: 'inv-1',
    });
    const update = (orderModel.updateOne.mock.calls[0] as any[])[1];
    expect(update.$push).toBeUndefined();
    expect(update.$set['infinitePay.paidAt']).toBeInstanceOf(Date);
  });

  it('falha de rede na consulta vira erro (a InfinitePay tenta de novo)', async () => {
    const { service } = setup({
      checkError: new InfinitePayApiError(0, 'network'),
    });
    await expect(
      service.handleWebhook({
        order_nsu: 'ref-1',
        transaction_nsu: 'tx-1',
        invoice_slug: 'inv-1',
      }),
    ).rejects.toThrow();
  });
});

describe('InfinitePayService.ensureCheckout — valor mínimo', () => {
  it('total abaixo de R$ 1,00 não chama a InfinitePay e explica o motivo', async () => {
    const order: any = {
      _id: new Types.ObjectId(),
      code: 9,
      businessId,
      total: 0.02,
      deliveryFee: 0.01,
      status: 'PENDENTE',
      customerName: 'Maria',
      requestedPayment: { prepaid: true },
      items: [{ productName: 'Teste', quantity: 1, unitPrice: 0.01 }],
    };
    const exec = (v: unknown) => ({ exec: () => Promise.resolve(v) });
    const client = { createLink: jest.fn(), paymentCheck: jest.fn() };
    const service = new InfinitePayService(
      { findOne: jest.fn(() => exec(order)), updateOne: jest.fn() } as any,
      {
        findById: jest.fn(() => ({
          select: () => ({
            lean: () =>
              exec({
                config: { infinitepay: { handle: 'loja', enabled: true } },
              }),
          }),
        })),
      } as any,
      { findOne: jest.fn() } as any,
      client as any,
    );
    await expect(
      service.ensureCheckout(businessId.toString(), 'ref-1'),
    ).rejects.toThrow('a partir de R$ 1,00');
    expect(client.createLink).not.toHaveBeenCalled();
  });
});

describe('InfinitePayService — consulta sem dados da transação', () => {
  it('sem transaction_nsu e slug nem chama a InfinitePay (ela só responde com os 4 dados)', async () => {
    const { service, client } = setup();
    const res = await service.handleWebhook({ order_nsu: 'ref-1' });
    expect(res.paid).toBe(false);
    expect(client.paymentCheck).not.toHaveBeenCalled();
  });

  it('operador: sem os dados avisa que depende da volta do checkout / webhook', async () => {
    const { service, client } = setup();
    const status = await service.verifyById('id', businessId.toString());
    expect(status).toMatchObject({ paid: false, needsReturn: true });
    expect(client.paymentCheck).not.toHaveBeenCalled();
  });
});

describe('InfinitePayService — pedido do painel com sinal', () => {
  const panelOrder = (over: object = {}) => ({
    _id: new Types.ObjectId(),
    code: 12,
    businessId,
    total: 100,
    deliveryFee: 10,
    status: 'PENDENTE',
    customerName: 'Maria',
    items: [{ productName: 'Bolo', quantity: 1, unitPrice: 90 }],
    infinitePay: { orderNsu: 'nsu-painel', chargeAmount: 40 },
    ...over,
  });

  it('confirma o sinal: valor pago = chargeAmount, não o total', async () => {
    const { service, orderModel } = setup({
      order: panelOrder(),
      check: { paid: true, amount: 4000, capture_method: 'pix' },
    });
    await service.handleWebhook({
      order_nsu: 'nsu-painel',
      transaction_nsu: 'tx-1',
      invoice_slug: 'inv-1',
    });
    const update = (orderModel.updateOne.mock.calls[0] as any[])[1];
    expect(update.$push.payments).toMatchObject({ method: 'PIX', amount: 40 });
  });

  it('recusa a confirmação se a InfinitePay informa o total quando o link era de sinal', async () => {
    const { service, orderModel } = setup({
      order: panelOrder(),
      check: { paid: true, amount: 10000, capture_method: 'pix' },
    });
    await service.handleWebhook({
      order_nsu: 'nsu-painel',
      transaction_nsu: 'tx-1',
      invoice_slug: 'inv-1',
    });
    expect(orderModel.updateOne).not.toHaveBeenCalled();
  });

  it('gera o link com uma linha só, no valor do sinal', async () => {
    const order: any = panelOrder();
    const { service, client } = setup({ order });
    (client.createLink as jest.Mock).mockResolvedValue({
      url: 'https://checkout.infinitepay.io/loja?lenc=abc',
    });
    const res = await service.ensureCheckoutById(
      order._id.toString(),
      businessId.toString(),
    );
    expect(res.checkoutUrl).toContain('infinitepay');
    const sent = (client.createLink as jest.Mock).mock.calls[0][0];
    expect(sent.order_nsu).toBe('nsu-painel');
    expect(sent.items).toEqual([
      {
        quantity: 1,
        price: 4000,
        description: 'Sinal do pedido #12 · 1x Bolo',
      },
    ]);
  });

  it('pedido inteiro sem desconto vai item a item no link', async () => {
    const order: any = panelOrder({
      total: 100,
      infinitePay: { orderNsu: 'nsu-painel' },
    });
    const { service, client } = setup({ order });
    (client.createLink as jest.Mock).mockResolvedValue({
      url: 'https://checkout.infinitepay.io/loja?lenc=abc',
    });
    await service.ensureCheckoutById(
      order._id.toString(),
      businessId.toString(),
    );
    const sent = (client.createLink as jest.Mock).mock.calls[0][0];
    expect(sent.items).toEqual([
      { quantity: 1, price: 9000, description: 'Bolo' },
      { quantity: 1, price: 1000, description: 'Taxa de entrega' },
    ]);
  });

  it('sinal abaixo de R$ 1,00 não chama a InfinitePay', async () => {
    const order: any = panelOrder({
      infinitePay: { orderNsu: 'nsu-painel', chargeAmount: 0.5 },
    });
    const { service, client } = setup({ order });
    await expect(
      service.ensureCheckoutById(order._id.toString(), businessId.toString()),
    ).rejects.toThrow('a partir de R$ 1,00');
    expect(client.createLink).not.toHaveBeenCalled();
  });
});
