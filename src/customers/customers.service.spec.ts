import { Types } from 'mongoose';
import { CustomersService } from './customers.service';
import { PaymentMethod } from '../common/enums/payment-method.enum';

/**
 * Construtor cru com mocks encadeaveis (find().sort().limit().lean().exec()),
 * mesmo estilo dos outros specs de service.
 */
function chain(result: unknown) {
  const q: any = {};
  for (const m of ['sort', 'limit', 'lean', 'select']) q[m] = jest.fn(() => q);
  q.exec = jest.fn(() => Promise.resolve(result));
  return q;
}

const businessId = new Types.ObjectId();
const customerId = new Types.ObjectId();
const at = (iso: string) => new Date(iso);

function setup(opts: { sales?: any[]; orders?: any[]; orderSales?: any[] }) {
  const saleFind = jest.fn((filter: any) =>
    chain(filter._id ? (opts.orderSales ?? []) : (opts.sales ?? [])),
  );
  const saleModel = {
    find: saleFind,
    findOne: jest.fn(() => chain(null)),
    aggregate: jest.fn(() => ({
      exec: () => Promise.resolve([{ count: 3, total: 150 }]),
    })),
  };
  const orderModel = {
    find: jest.fn(() => chain(opts.orders ?? [])),
    findOne: jest.fn(() => chain(null)),
    countDocuments: jest.fn(() => ({ exec: () => Promise.resolve(1) })),
  };
  const service = new CustomersService(
    {} as any,
    saleModel as any,
    orderModel as any,
  );
  jest.spyOn(service, 'findOne').mockResolvedValue({
    _id: customerId,
    name: 'Ana',
    outstandingDebt: 20,
  } as any);
  return { service, saleFind, orderModel };
}

const sale = (over: any = {}) => ({
  _id: new Types.ObjectId(),
  status: 'CONCLUIDA',
  channel: 'CAIXA',
  total: 30,
  payments: [{ method: PaymentMethod.PIX, amount: 30 }],
  items: [{ productName: 'Bolo', quantity: 1, subtotal: 30 }],
  debtSettled: false,
  ...over,
});

const order = (over: any = {}) => ({
  _id: new Types.ObjectId(),
  code: 7,
  status: 'PENDENTE',
  source: 'CARDAPIO',
  total: 40,
  deliveryAt: at('2026-10-20T15:00:00Z'),
  payments: [],
  items: [
    { productName: 'Torta', quantity: 2, subtotal: 40, notes: 'sem açúcar' },
  ],
  ...over,
});

describe('CustomersService.getOrderHistory', () => {
  it('junta vendas e encomendas, da mais recente para a mais antiga', async () => {
    const { service } = setup({
      sales: [sale({ createdAt: at('2026-10-10T12:00:00Z') })],
      orders: [order({ createdAt: at('2026-10-15T12:00:00Z') })],
    });
    const result = await service.getOrderHistory(
      customerId.toString(),
      businessId.toString(),
    );

    expect(result.entries.map((e) => [e.kind, e.code])).toEqual([
      ['ENCOMENDA', 7],
      ['VENDA', null],
    ]);
    expect(result.entries[0]).toMatchObject({
      source: 'CARDAPIO',
      items: [{ productName: 'Torta', quantity: 2, notes: 'sem açúcar' }],
    });
    expect(result.outstandingTotal).toBe(20);
  });

  it('não duplica: vendas geradas por encomenda ficam de fora da busca de vendas', async () => {
    const { service, saleFind } = setup({});
    await service.getOrderHistory(customerId.toString(), businessId.toString());
    expect(saleFind.mock.calls[0][0]).toMatchObject({
      orderId: { $exists: false },
    });
  });

  it('encomenda entregue usa os pagamentos e o fiado da venda que gerou', async () => {
    const generated = sale({
      total: 40,
      payments: [
        { method: PaymentMethod.PIX, amount: 10 },
        { method: PaymentMethod.FIADO, amount: 30 },
      ],
    });
    const { service } = setup({
      orders: [
        order({
          status: 'ENTREGUE',
          saleId: generated._id,
          createdAt: at('2026-10-15T12:00:00Z'),
        }),
      ],
      orderSales: [generated],
    });
    const [entry] = (
      await service.getOrderHistory(
        customerId.toString(),
        businessId.toString(),
      )
    ).entries;

    expect(entry.payments).toEqual([
      { method: PaymentMethod.PIX, amount: 10 },
      { method: PaymentMethod.FIADO, amount: 30 },
    ]);
    expect(entry.fiado).toEqual({
      saleId: String(generated._id),
      amount: 30,
      settled: false,
      settledAt: null,
    });
  });

  it('venda cancelada não conta como fiado em aberto', async () => {
    const { service } = setup({
      sales: [
        sale({
          status: 'CANCELADA',
          payments: [{ method: PaymentMethod.FIADO, amount: 30 }],
          createdAt: at('2026-10-10T12:00:00Z'),
        }),
      ],
    });
    const [entry] = (
      await service.getOrderHistory(
        customerId.toString(),
        businessId.toString(),
      )
    ).entries;
    expect(entry.status).toBe('CANCELADA');
    expect(entry.fiado).toBeNull();
  });

  it('pagina por cursor: limita, devolve o próximo cursor e só manda resumo na 1ª página', async () => {
    const sales = [3, 2, 1].map((d) =>
      sale({ createdAt: at(`2026-10-0${d}T12:00:00Z`) }),
    );
    const first = await setup({ sales }).service.getOrderHistory(
      customerId.toString(),
      businessId.toString(),
      {
        limit: 2,
      },
    );
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBe('2026-10-02T12:00:00.000Z');
    expect(first.summary).toEqual({
      orderCount: 4, // 3 vendas concluidas + 1 encomenda em andamento
      totalSpent: 150,
      openOrders: 1,
      lastOrderAt: null,
    });

    const { service, saleFind } = setup({ sales: sales.slice(2) });
    const next = await service.getOrderHistory(
      customerId.toString(),
      businessId.toString(),
      {
        limit: 2,
        before: first.nextCursor!,
      },
    );
    expect(saleFind.mock.calls[0][0].createdAt.$lt.toISOString()).toBe(
      first.nextCursor,
    );
    expect(next.nextCursor).toBeNull();
    expect(next.summary).toBeNull();
  });
});
