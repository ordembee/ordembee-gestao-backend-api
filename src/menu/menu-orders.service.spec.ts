import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import {
  MAX_MENU_ORDERS_PER_STORE_PER_HOUR,
  MenuOrdersService,
  formatAddress,
  formatPhone,
  phoneDigitsPattern,
  resolveChosenOptions,
} from './menu-orders.service';
import { OrderFulfillment } from '../orders/schemas/order.schema';
import { PaymentMethod } from '../common/enums/payment-method.enum';

/** Sexta 2026-10-16 15:00 em São Paulo. */
const NOW = new Date('2026-10-16T18:00:00Z');
const bolo = new Types.ObjectId();
const torta = new Types.ObjectId();

const lean = (value: unknown) => ({
  select: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }),
});

function setup(
  over: {
    business?: any;
    products?: any[];
    customer?: any;
    lastHour?: number;
    existing?: { code: number; total: number } | null;
  } = {},
) {
  const business =
    over.business === undefined
      ? {
          _id: new Types.ObjectId(),
          timezone: 'America/Sao_Paulo',
          menu: {
            enabled: true,
            deliveryFee: 6,
            pickupEnabled: true,
            openingHours: { '5': ['11:00', '23:00'] },
            items: [
              { productId: bolo, active: true, order: 0 },
              { productId: torta, active: true, order: 1 },
            ],
          },
        }
      : over.business;
  const products = over.products ?? [
    {
      _id: bolo,
      name: 'Bolo',
      isActive: true,
      stock: -1,
      prices: { deliveryProprio: { value: 30, active: true } },
    },
    {
      _id: torta,
      name: 'Torta',
      isActive: true,
      stock: 0,
      prices: { deliveryProprio: { value: 50, active: true } },
    },
  ];
  const customerModel = {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(over.customer ?? null),
    })),
    create: jest.fn(async (doc: any) => ({
      _id: new Types.ObjectId(),
      ...doc,
    })),
  };
  const ordersService = {
    findMenuOrderByRef: jest.fn(async () => over.existing ?? null),
    countMenuOrdersSince: jest.fn(async (_businessId: string, _since: Date) => over.lastHour ?? 0),
    createFromMenu: jest.fn(async (input: any) => ({
      code: 42,
      total:
        input.items.reduce(
          (s: number, i: any) => s + i.unitPrice * i.quantity,
          0,
        ) + input.deliveryFee,
    })),
  };
  const service = new MenuOrdersService(
    { findOne: jest.fn(() => lean(business)) } as any,
    { find: jest.fn(() => lean(products)) } as any,
    customerModel as any,
    ordersService as any,
  );
  return { service, ordersService, customerModel };
}

const baseDto = (over: any = {}) => ({
  slug: 'tia-nana',
  orderRef: '0b6f2a52-6c0e-4b6e-9a51-6d5c2f0e9b11',
  customer: { name: 'Maria Souza', phone: '11987654321' },
  fulfillment: OrderFulfillment.ENTREGA,
  address: { street: 'Rua das Flores', number: '120', district: 'Centro' },
  payment: { method: PaymentMethod.PIX },
  items: [{ productId: bolo.toString(), quantity: 2, unitPrice: 0.01 }],
  ...over,
});

describe('MenuOrdersService.create', () => {
  it('usa o preço do banco, nunca o enviado, e soma a taxa de entrega', async () => {
    const { service, ordersService } = setup();
    const result = await service.create(baseDto() as any, NOW);

    const input = ordersService.createFromMenu.mock.calls[0][0];
    expect(input.items).toEqual([
      {
        productId: bolo.toString(),
        unitPrice: 30,
        quantity: 2,
        notes: undefined,
        options: [],
      },
    ]);
    expect(input.deliveryFee).toBe(6);
    expect(input.externalRef).toBe(baseDto().orderRef);
    expect(result).toEqual({ code: 42, total: 66 });
  });

  it('retirada não cobra taxa e não grava endereço', async () => {
    const { service, ordersService } = setup();
    await service.create(
      baseDto({
        fulfillment: OrderFulfillment.RETIRADA,
        address: undefined,
      }) as any,
      NOW,
    );
    const input = ordersService.createFromMenu.mock.calls[0][0];
    expect(input.deliveryFee).toBe(0);
    expect(input.customerAddress).toBeUndefined();
  });

  it('404 para slug inexistente', async () => {
    const { service } = setup({ business: null });
    await expect(service.create(baseDto() as any, NOW)).rejects.toThrow(
      NotFoundException,
    );
  });

  it.each([
    [
      'cardápio desativado',
      { menu: { enabled: false, openingHours: { '5': ['11:00', '23:00'] } } },
      'MENU_DISABLED',
    ],
    [
      'loja fechada',
      { menu: { enabled: true, openingHours: { '5': ['18:00', '23:00'] } } },
      'STORE_CLOSED',
    ],
  ])('409 quando %s', async (_label, partial, reason) => {
    const { service } = setup({
      business: {
        _id: new Types.ObjectId(),
        timezone: 'America/Sao_Paulo',
        ...partial,
      },
    });
    await expect(service.create(baseDto() as any, NOW)).rejects.toMatchObject({
      response: expect.objectContaining({ reason }),
    });
  });

  it('409 PRODUCT_UNAVAILABLE para esgotado ou fora do cardápio', async () => {
    const { service } = setup();
    const esgotado = baseDto({
      items: [{ productId: torta.toString(), quantity: 1 }],
    });
    await expect(service.create(esgotado as any, NOW)).rejects.toThrow(
      ConflictException,
    );
    const inexistente = baseDto({
      items: [{ productId: new Types.ObjectId().toString(), quantity: 1 }],
    });
    await expect(service.create(inexistente as any, NOW)).rejects.toMatchObject(
      {
        response: expect.objectContaining({ reason: 'PRODUCT_UNAVAILABLE' }),
      },
    );
  });

  it('409 quando o produto existe mas está desligado no cardápio', async () => {
    const { service } = setup({
      business: {
        _id: new Types.ObjectId(),
        timezone: 'America/Sao_Paulo',
        menu: {
          enabled: true,
          openingHours: { '5': ['11:00', '23:00'] },
          items: [{ productId: bolo, active: false, order: 0 }],
        },
      },
    });
    await expect(service.create(baseDto() as any, NOW)).rejects.toMatchObject({
      response: expect.objectContaining({ reason: 'PRODUCT_UNAVAILABLE' }),
    });
  });

  it('recusa troco menor que o total', async () => {
    const { service } = setup();
    const dto = baseDto({
      payment: { method: PaymentMethod.DINHEIRO, changeFor: 50 },
    });
    await expect(service.create(dto as any, NOW)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('reaproveita o cliente achado pelo telefone e só cria quando não existe', async () => {
    const existing = {
      _id: new Types.ObjectId(),
      name: 'Maria',
      phone: '(11) 98765-4321',
      address: 'x',
      save: jest.fn(),
    };
    const found = setup({ customer: existing });
    await found.service.create(baseDto() as any, NOW);
    expect(found.customerModel.create).not.toHaveBeenCalled();
    expect(found.ordersService.createFromMenu.mock.calls[0][0].customer).toBe(
      existing,
    );

    const fresh = setup();
    await fresh.service.create(baseDto() as any, NOW);
    expect(fresh.customerModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Maria Souza',
        phone: '(11) 98765-4321',
      }),
    );
  });
});

describe('helpers do pedido do cardápio', () => {
  it('formata telefone', () => {
    expect(formatPhone('11987654321')).toBe('(11) 98765-4321');
    expect(formatPhone('1133334444')).toBe('(11) 3333-4444');
  });

  it('acha o telefone com qualquer máscara', () => {
    const re = phoneDigitsPattern('11987654321');
    expect(re.test('(11) 98765-4321')).toBe(true);
    expect(re.test('11 98765 4321')).toBe(true);
    expect(re.test('(11) 98765-4322')).toBe(false);
    expect(re.test('5511987654321')).toBe(false);
  });

  it('monta o endereço em linhas', () => {
    expect(
      formatAddress({
        street: 'Rua A',
        number: '1',
        district: 'Centro',
        complement: 'Apto 2',
        cep: '01001-000',
        reference: 'Praça',
      }),
    ).toBe('Rua A, 1 – Apto 2\nCentro · CEP 01001-000\nRef.: Praça');
  });
});

describe('complementos no pedido — resolveChosenOptions', () => {
  const groups = [
    {
      id: 'g1',
      name: 'Bebida',
      min: 0,
      max: 2,
      options: [
        { id: 'a', name: 'Coca', price: 7.9 },
        { id: 'b', name: 'Suco', price: 5 },
        { id: 'c', name: 'Água', price: 3 },
      ],
    },
    {
      id: 'g2',
      name: 'Descartáveis',
      min: 1,
      max: 1,
      options: [
        { id: 'd', name: 'Colher', price: 0.9 },
        { id: 'e', name: 'Não preciso', price: 0 },
      ],
    },
  ];

  it('aceita escolhas válidas e devolve nome/preço do banco', () => {
    expect(
      resolveChosenOptions('Torta', groups, [
        { groupId: 'g1', optionId: 'a' },
        { groupId: 'g2', optionId: 'e' },
      ]),
    ).toEqual([
      { groupName: 'Bebida', name: 'Coca', price: 7.9 },
      { groupName: 'Descartáveis', name: 'Não preciso', price: 0 },
    ]);
  });

  it.each([
    ['faltando obrigatório', [{ groupId: 'g1', optionId: 'a' }]],
    [
      'acima do máximo',
      [
        { groupId: 'g1', optionId: 'a' },
        { groupId: 'g1', optionId: 'b' },
        { groupId: 'g1', optionId: 'c' },
        { groupId: 'g2', optionId: 'e' },
      ],
    ],
    [
      'opção de outro grupo',
      [
        { groupId: 'g1', optionId: 'd' },
        { groupId: 'g2', optionId: 'e' },
      ],
    ],
    [
      'repetida',
      [
        { groupId: 'g2', optionId: 'e' },
        { groupId: 'g2', optionId: 'e' },
      ],
    ],
    [
      'grupo que o item não tem',
      [
        { groupId: 'zz', optionId: 'a' },
        { groupId: 'g2', optionId: 'e' },
      ],
    ],
  ])('recusa %s', (_label, chosen) => {
    expect(() => resolveChosenOptions('Torta', groups, chosen)).toThrow(
      BadRequestException,
    );
  });
});

describe('MenuOrdersService.create — complementos e pagamento', () => {
  const groupId = new Types.ObjectId();
  const coca = new Types.ObjectId();
  const withMenu = (extra: any) => ({
    _id: new Types.ObjectId(),
    timezone: 'America/Sao_Paulo',
    menu: {
      enabled: true,
      deliveryFee: 6,
      openingHours: { '5': ['11:00', '23:00'] },
      items: [
        { productId: bolo, active: true, order: 0, optionGroupIds: [groupId] },
      ],
      optionGroups: [
        {
          _id: groupId,
          name: 'Bebida',
          min: 0,
          max: 1,
          options: [{ _id: coca, name: 'Coca', price: 7.9 }],
        },
      ],
      ...extra,
    },
  });

  it('soma o preço dos complementos no item e grava o que foi escolhido', async () => {
    const { service, ordersService } = setup({ business: withMenu({}) });
    await service.create(
      baseDto({
        items: [
          {
            productId: bolo.toString(),
            quantity: 2,
            options: [
              { groupId: groupId.toString(), optionId: coca.toString() },
            ],
          },
        ],
      }) as any,
      NOW,
    );
    const [item] = ordersService.createFromMenu.mock.calls[0][0].items;
    expect(item.unitPrice).toBe(37.9); // 30 + 7,90
    expect(item.options).toEqual([
      { groupName: 'Bebida', name: 'Coca', price: 7.9 },
    ]);
  });

  it('recusa forma de pagamento que a loja não aceita', async () => {
    const { service } = setup({
      business: withMenu({ acceptedPayments: ['DINHEIRO'] }),
    });
    await expect(service.create(baseDto() as any, NOW)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('recusa entrega quando a loja só faz retirada', async () => {
    const { service } = setup({
      business: {
        _id: new Types.ObjectId(),
        timezone: 'America/Sao_Paulo',
        menu: {
          enabled: true,
          deliveryEnabled: false,
          openingHours: { '5': ['11:00', '23:00'] },
          items: [{ productId: bolo, active: true, order: 0 }],
        },
      },
    });
    await expect(service.create(baseDto() as any, NOW)).rejects.toThrow(
      BadRequestException,
    );
    // retirada continua aceita
    await expect(
      service.create(
        baseDto({
          fulfillment: OrderFulfillment.RETIRADA,
          address: undefined,
        }) as any,
        NOW,
      ),
    ).resolves.toMatchObject({ code: 42 });
  });
});

describe('MenuOrdersService.create — estoque e abuso', () => {
  const doce = new Types.ObjectId();
  const kit = new Types.ObjectId();
  const businessWith = (ids: Types.ObjectId[]) => ({
    _id: new Types.ObjectId(),
    timezone: 'America/Sao_Paulo',
    menu: {
      enabled: true,
      pickupEnabled: true,
      openingHours: { '5': ['11:00', '23:00'] },
      items: ids.map((productId, order) => ({ productId, active: true, order })),
    },
  });
  const doceProduct = (stock: number) => ({
    _id: doce,
    name: 'Doce',
    isActive: true,
    stock,
    prices: { deliveryProprio: { value: 5, active: true } },
  });
  const pickup = (items: any[]) =>
    baseDto({ fulfillment: OrderFulfillment.RETIRADA, address: undefined, items });

  it('soma linhas repetidas do mesmo produto antes de comparar com o estoque', async () => {
    const { service, ordersService } = setup({
      business: businessWith([doce]),
      products: [doceProduct(3)],
    });
    const line = { productId: doce.toString(), quantity: 2 };
    await expect(service.create(pickup([line, line]), NOW)).rejects.toMatchObject({
      response: { reason: 'INSUFFICIENT_STOCK' },
    });
    expect(ordersService.createFromMenu).not.toHaveBeenCalled();
  });

  it('recusa sem revelar quanto resta', async () => {
    const { service } = setup({ business: businessWith([doce]), products: [doceProduct(2)] });
    const err = await service
      .create(pickup([{ productId: doce.toString(), quantity: 10 }]), NOW)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.response.message).toBe('Quantidade indisponível para Doce');
    expect(err.response.message).not.toMatch(/\d/);
  });

  it('aceita até o estoque exato', async () => {
    const { service, ordersService } = setup({
      business: businessWith([doce]),
      products: [doceProduct(2)],
    });
    await service.create(pickup([{ productId: doce.toString(), quantity: 2 }]), NOW);
    expect(ordersService.createFromMenu).toHaveBeenCalled();
  });

  it('combo usa o estoque dos componentes', async () => {
    const combo = {
      _id: kit,
      name: 'Kit',
      isActive: true,
      isCombo: true,
      stock: -1,
      comboItems: [{ productId: doce, quantity: 2 }],
      prices: { deliveryProprio: { value: 9, active: true } },
    };
    const { service } = setup({
      business: businessWith([kit]),
      products: [combo, doceProduct(3)],
    });
    // 2 kits = 4 doces, mas só há 3.
    await expect(
      service.create(pickup([{ productId: kit.toString(), quantity: 2 }]), NOW),
    ).rejects.toMatchObject({ response: { reason: 'INSUFFICIENT_STOCK' } });
  });

  it('retry de pedido já criado devolve o mesmo, sem revalidar', async () => {
    const { service, ordersService } = setup({
      existing: { code: 7, total: 60 },
    });
    await expect(service.create(baseDto(), NOW)).resolves.toEqual({ code: 7, total: 60 });
    expect(ordersService.createFromMenu).not.toHaveBeenCalled();
  });

  it('limita a 10 unidades de cada item, somando as linhas', async () => {
    const { service, ordersService } = setup();
    const items = [
      { productId: bolo.toString(), quantity: 6 },
      { productId: bolo.toString(), quantity: 5 },
    ];
    await expect(service.create(baseDto({ items }), NOW)).rejects.toThrow('10 unidades de cada item');
    expect(ordersService.createFromMenu).not.toHaveBeenCalled();
  });

  it('limita o pedido a 20 itens no total', async () => {
    const outros = [1, 2, 3].map(() => new Types.ObjectId());
    const items = [bolo, ...outros].map((id) => ({ productId: id.toString(), quantity: 6 }));
    const { service, ordersService } = setup();
    await expect(service.create(baseDto({ items }), NOW)).rejects.toThrow('no máximo 20 itens');
    expect(ordersService.createFromMenu).not.toHaveBeenCalled();
  });

  it('teto de pedidos do cardápio por loja na última hora', async () => {
    const { service, ordersService } = setup({ lastHour: MAX_MENU_ORDERS_PER_STORE_PER_HOUR });
    await expect(service.create(baseDto(), NOW)).rejects.toMatchObject({
      response: { reason: 'STORE_BUSY' },
    });
    expect(ordersService.createFromMenu).not.toHaveBeenCalled();
    const since = ordersService.countMenuOrdersSince.mock.calls[0][1] as Date;
    expect(NOW.getTime() - since.getTime()).toBe(60 * 60 * 1000);
  });

  it('abaixo do teto segue normalmente', async () => {
    const { service, ordersService } = setup({ lastHour: MAX_MENU_ORDERS_PER_STORE_PER_HOUR - 1 });
    await service.create(baseDto(), NOW);
    expect(ordersService.createFromMenu).toHaveBeenCalled();
  });
});
