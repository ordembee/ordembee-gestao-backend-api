import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { MENU_ORDER_LATE_GRACE_MS, OrdersService, lateOrdersFilter } from './orders.service';
import { OrderSource, OrderStatus } from './schemas/order.schema';
import { PaymentMethod } from '../common/enums/payment-method.enum';

/**
 * Construtor cru (sem o container do Nest) — mesma abordagem do
 * `sales.service.spec.ts`: os testes exercitam a regra de negocio pura, com
 * mocks so do que cada caso toca.
 */
function buildService(overrides: Partial<Record<string, any>> = {}) {
  return new OrdersService(
    overrides.orderModel ?? ({} as any),
    overrides.counterModel ?? ({} as any),
    overrides.productModel ?? ({} as any),
    overrides.userModel ?? ({} as any),
    overrides.customerModel ?? ({} as any),
    overrides.stockMovementsService ?? ({ recordSaleMovement: jest.fn() } as any),
    overrides.pricingsService ?? ({ findManyByIds: jest.fn().mockResolvedValue([]) } as any),
    overrides.campaignsService ?? ({
        prepareForDocument: jest
          .fn()
          .mockResolvedValue({ tags: [], discount: null, added: [], removed: [], existing: [] }),
        commitUsage: jest.fn().mockResolvedValue(undefined),
        releaseUsage: jest.fn().mockResolvedValue(undefined),
      } as any),
    overrides.salesService ?? ({} as any),
    overrides.businessService ??
      ({ getTimezone: jest.fn().mockResolvedValue('America/Sao_Paulo') } as any),
  );
}

describe('OrdersService — estoque', () => {
  it('expande combos nos componentes em vez de mover o proprio combo', () => {
    const service = buildService();
    const comboId = new Types.ObjectId();
    const massaId = new Types.ObjectId();
    const recheioId = new Types.ObjectId();

    const delta = (service as any).buildStockDelta([
      {
        productId: comboId,
        productName: 'Kit festa',
        quantity: 2,
        comboComponents: [
          { productId: massaId, productName: 'Massa', quantity: 1 },
          { productId: recheioId, productName: 'Recheio', quantity: 3 },
        ],
      },
    ]);

    expect(delta.has(String(comboId))).toBe(false);
    expect(delta.get(String(massaId)).quantity).toBe(2);
    expect(delta.get(String(recheioId)).quantity).toBe(6);
  });

  it('soma quantidades do mesmo produto vindas de itens diferentes', () => {
    const service = buildService();
    const bolo = new Types.ObjectId();
    const comboId = new Types.ObjectId();

    const delta = (service as any).buildStockDelta([
      { productId: bolo, productName: 'Bolo', quantity: 2, comboComponents: [] },
      {
        productId: comboId,
        productName: 'Combo',
        quantity: 1,
        comboComponents: [{ productId: bolo, productName: 'Bolo', quantity: 3 }],
      },
    ]);

    expect(delta.get(String(bolo)).quantity).toBe(5);
  });

  it('na edicao, move apenas a diferenca entre a lista antiga e a nova', () => {
    const service = buildService();
    const bolo = new Types.ObjectId();
    const torta = new Types.ObjectId();

    const previous = (service as any).buildStockDelta([
      { productId: bolo, productName: 'Bolo', quantity: 3, comboComponents: [] },
      { productId: torta, productName: 'Torta', quantity: 1, comboComponents: [] },
    ]);
    const next = (service as any).buildStockDelta([
      { productId: bolo, productName: 'Bolo', quantity: 5, comboComponents: [] },
    ]);

    const diff = (service as any).diffStockDelta(next, previous);

    // +2 do bolo saem do estoque; a torta removida volta para o estoque.
    expect(diff.get(String(bolo)).quantity).toBe(2);
    expect(diff.get(String(torta)).quantity).toBe(-1);
  });

  it('descarta do delta os produtos cuja quantidade nao mudou', () => {
    const service = buildService();
    const bolo = new Types.ObjectId();

    const same = [
      { productId: bolo, productName: 'Bolo', quantity: 2, comboComponents: [] },
    ];
    const diff = (service as any).diffStockDelta(
      (service as any).buildStockDelta(same),
      (service as any).buildStockDelta(same),
    );

    expect(diff.size).toBe(0);
  });
});

describe('OrdersService — pagamentos', () => {
  it('rejeita pagamento acima do que falta', () => {
    const service = buildService();
    expect(() =>
      (service as any).assertPaymentsFit(
        [{ method: PaymentMethod.PIX, amount: 60 }],
        100,
        50,
      ),
    ).toThrow(BadRequestException);
  });

  it('aceita quitar exatamente o saldo restante', () => {
    const service = buildService();
    expect(() =>
      (service as any).assertPaymentsFit(
        [{ method: PaymentMethod.PIX, amount: 50 }],
        100,
        50,
      ),
    ).not.toThrow();
  });

  it('calcula pago/falta a partir do extrato, sem persistir os totais', () => {
    const service = buildService();
    const order = {
      total: 100,
      payments: [
        { method: PaymentMethod.PIX, amount: 30 },
        { method: PaymentMethod.DINHEIRO, amount: 20 },
      ],
      toObject: () => ({ total: 100 }),
    } as any;

    const result = (service as any).withTotals(order);
    expect(result.amountPaid).toBe(50);
    expect(result.amountDue).toBe(50);
    expect(result.isPaid).toBe(false);
  });
});

describe('OrdersService.deliver', () => {
  const businessId = new Types.ObjectId().toString();

  function buildOrder(payments: any[], total = 100) {
    return {
      _id: new Types.ObjectId(),
      code: 7,
      status: OrderStatus.PRONTO,
      total,
      deliveryFee: 0,
      tags: ['NATAL2025'],
      customerId: new Types.ObjectId(),
      customerName: 'Maria',
      items: [
        {
          productId: new Types.ObjectId(),
          productName: 'Bolo',
          unitPrice: total,
          costPrice: 10,
          quantity: 1,
          subtotal: total,
          profit: total - 10,
          comboComponents: [],
        },
      ],
      payments,
      statusHistory: [],
      save: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  function buildDeps(order: any) {
    const createFromOrder = jest
      .fn()
      .mockResolvedValue({ _id: new Types.ObjectId() });
    const service = buildService({
      orderModel: {
        findOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(order) })),
      },
      userModel: {
        findOne: jest.fn(() => ({
          exec: jest
            .fn()
            .mockResolvedValue({ _id: new Types.ObjectId(), displayName: 'Op' }),
        })),
      },
      salesService: { createFromOrder },
    });
    // findOne() publico so reformata o documento — nao precisa ir ao banco.
    jest.spyOn(service, 'findOne').mockImplementation(async () => order);
    return { service, createFromOrder };
  }

  it('soma sinal e quitacao por forma de pagamento na venda gerada', async () => {
    const order = buildOrder([
      { method: PaymentMethod.PIX, amount: 30, kind: 'SINAL' },
    ]);
    const { service, createFromOrder } = buildDeps(order);

    await service.deliver('id', businessId, 'uid', {
      payments: [{ method: PaymentMethod.PIX, amount: 70 }],
    });

    const payload = createFromOrder.mock.calls[0][0];
    expect(payload.payments).toEqual([{ method: PaymentMethod.PIX, amount: 100 }]);
    expect(payload.tags).toEqual(['NATAL2025']);
    expect(order.status).toBe(OrderStatus.ENTREGUE);
    expect(order.deliveredAt).toBeInstanceOf(Date);
  });

  it('transforma o saldo nao pago em parcela FIADO da venda', async () => {
    const order = buildOrder([
      { method: PaymentMethod.DINHEIRO, amount: 40, kind: 'SINAL' },
    ]);
    const { service, createFromOrder } = buildDeps(order);

    await service.deliver('id', businessId, 'uid', { payments: [] });

    const payload = createFromOrder.mock.calls[0][0];
    expect(payload.payments).toEqual([
      { method: PaymentMethod.DINHEIRO, amount: 40 },
      { method: PaymentMethod.FIADO, amount: 60 },
    ]);
  });

  it('nao deixa entregar uma encomenda ja cancelada', async () => {
    const order = buildOrder([]);
    order.status = OrderStatus.CANCELADA;
    const { service } = buildDeps(order);

    await expect(
      service.deliver('id', businessId, 'uid', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OrdersService.updateStatus', () => {
  it('manda usar a acao de entrega em vez de avancar o status direto', async () => {
    const order = {
      status: OrderStatus.PRONTO,
      statusHistory: [],
      save: jest.fn(),
    } as any;
    const service = buildService({
      orderModel: {
        findOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(order) })),
      },
    });

    await expect(
      service.updateStatus('id', 'biz', 'uid', OrderStatus.ENTREGUE),
    ).rejects.toThrow(/Entregar/);
  });
});

describe('OrdersService.buildDeliveryAt', () => {
  it('monta o instante no fuso do negocio, nao no do servidor', () => {
    const service = buildService();
    const withTime = (service as any).buildDeliveryAt(
      '2026-09-17',
      '14:30',
      'America/Sao_Paulo',
    );
    // 14:30 em GMT-3 = 17:30 UTC.
    expect(withTime.toISOString()).toBe('2026-09-17T17:30:00.000Z');
  });

  it('sem hora, ancora na meia-noite do dia no fuso do negocio', () => {
    const service = buildService();
    const noTime = (service as any).buildDeliveryAt(
      '2026-09-17',
      null,
      'America/Sao_Paulo',
    );
    expect(noTime.toISOString()).toBe('2026-09-17T03:00:00.000Z');
  });
});

describe('OrdersService — feed de pedidos do cardápio', () => {
  function feedService(orders: any[] = []) {
    const find = jest.fn(() => ({
      sort: () => ({ limit: () => ({ select: () => ({ lean: () => ({ exec: () => Promise.resolve(orders) }) }) }) }),
    }));
    return { service: buildService({ orderModel: { find } }), find };
  }

  it('só busca pedidos do cardápio depois de `since`', async () => {
    const { service, find } = feedService([
      { _id: new Types.ObjectId(), code: 7, customerName: 'Ana', total: 20, fulfillment: 'ENTREGA', createdAt: new Date() },
    ]);
    const since = new Date(Date.now() - 60_000).toISOString();
    const result = await service.getMenuFeed(new Types.ObjectId().toString(), since);

    const filter = (find.mock.calls[0] as any[])[0];
    expect(filter.source).toBe('CARDAPIO');
    expect(filter.createdAt.$gt.toISOString()).toBe(since);
    expect(result.orders[0]).toMatchObject({ code: 7, customerName: 'Ana', total: 20 });
    expect(typeof result.serverTime).toBe('string');
  });

  it('limita a janela a 24h quando `since` é antigo ou inválido', async () => {
    for (const since of ['2020-01-01T00:00:00Z', 'lixo']) {
      const { service, find } = feedService();
      await service.getMenuFeed(new Types.ObjectId().toString(), since);
      const from: Date = (find.mock.calls[0] as any[])[0].createdAt.$gt;
      expect(Date.now() - from.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
      expect(Date.now() - from.getTime()).toBeGreaterThan(23 * 60 * 60 * 1000);
    }
  });
});

describe('lateOrdersFilter', () => {
  it('dá folga ao pedido do cardápio e mantém a hora exata para os demais', () => {
    const now = new Date('2026-10-20T22:00:00Z');
    const filter = lateOrdersFilter(now) as any;
    expect(filter.status.$in).toEqual([OrderStatus.PENDENTE, OrderStatus.EM_PRODUCAO, OrderStatus.PRONTO]);
    const [interno, cardapio] = filter.$or;
    expect(interno).toEqual({ source: { $ne: OrderSource.CARDAPIO }, deliveryAt: { $lt: now } });
    expect(cardapio.source).toBe(OrderSource.CARDAPIO);
    expect(now.getTime() - cardapio.deliveryAt.$lt.getTime()).toBe(MENU_ORDER_LATE_GRACE_MS);
  });
});

describe('OrdersService.reserveStock (cardápio)', () => {
  const doce = new Types.ObjectId();
  const torta = new Types.ObjectId();
  const businessId = new Types.ObjectId().toString();
  const delta = (entries: [Types.ObjectId, number][]) =>
    new Map(entries.map(([id, quantity]) => [String(id), { productId: id, productName: String(id), quantity }]));

  function modelWith(stocks: Record<string, number>) {
    const state = { ...stocks };
    return {
      state,
      find: jest.fn(() => ({
        select: () => ({
          lean: () => ({
            exec: async () =>
              Object.entries(state)
                .filter(([, v]) => v !== -1)
                .map(([id]) => ({ _id: new Types.ObjectId(id) })),
          }),
        }),
      })),
      findOneAndUpdate: jest.fn((filter: any, update: any) => ({
        lean: () => ({
          exec: async () => {
            const id = String(filter._id);
            const before = state[id];
            if (before === undefined || before < filter.stock.$gte) return null;
            state[id] = before + update.$inc.stock;
            return { stock: before, name: 'Produto' };
          },
        }),
      })),
      bulkWrite: jest.fn(async (ops: any[]) => {
        for (const op of ops) state[String(op.updateOne.filter._id)] += op.updateOne.update.$inc.stock;
      }),
    };
  }

  it('baixa só quando há a quantidade inteira e devolve o histórico real', async () => {
    const productModel = modelWith({ [String(doce)]: 2 });
    const service = buildService({ productModel });
    const reserved = await (service as any).reserveStock(businessId, delta([[doce, 2]]));
    expect(productModel.state[String(doce)]).toBe(0);
    expect(reserved[0]).toMatchObject({ quantity: 2, previousStock: 2, newStock: 0 });
  });

  it('sem estoque suficiente recusa e desfaz o que já tinha baixado', async () => {
    const productModel = modelWith({ [String(doce)]: 5, [String(torta)]: 1 });
    const service = buildService({ productModel });
    await expect(
      (service as any).reserveStock(businessId, delta([[doce, 2], [torta, 3]])),
    ).rejects.toMatchObject({ response: { reason: 'INSUFFICIENT_STOCK' } });
    expect(productModel.state[String(doce)]).toBe(5);
    expect(productModel.state[String(torta)]).toBe(1);
  });

  it('ignora produto sem controle de estoque (-1)', async () => {
    const productModel = modelWith({ [String(doce)]: -1 });
    const service = buildService({ productModel });
    await expect((service as any).reserveStock(businessId, delta([[doce, 99]]))).resolves.toEqual([]);
    expect(productModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
