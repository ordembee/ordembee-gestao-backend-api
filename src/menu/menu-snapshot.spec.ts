import {
  availabilityLevel,
  buildMenuSnapshot,
  isProductAvailable,
  snapshotContentHash,
  MenuSourceCategoryOrder,
  MenuSourceItem,
  MenuSourceProduct,
  resolveOptionGroups,
} from './menu-snapshot';
import { isOpenAt, isValidOpeningHours } from './menu-hours.util';

const store = {
  slug: 'tia-nana',
  name: 'Tia Naná',
  description: '',
  logoUrl: null,
  coverUrl: null,
  address: '',
  whatsapp: '',
  timezone: 'America/Sao_Paulo',
  deliveryFee: 5,
  deliveryEnabled: true,
  deliveryProvider: 'PROPRIA' as const,
  pickupEnabled: true,
  openingHours: {},
  instagram: '',
  highlightLabel: '',
  highlightTitle: '',
  themeColor: null,
  acceptedPayments: ['PIX'],
};

const product = (over: Partial<MenuSourceProduct> = {}): MenuSourceProduct => ({
  _id: over._id ?? Math.random().toString(16).slice(2),
  name: 'Bolo',
  categoryId: 'cat-bolos',
  isActive: true,
  stock: -1,
  prices: { ordemBee: { value: 10, active: true } },
  ...over,
});

/** Por padrao todo produto esta ativo no cardapio; `items` sobrescreve por id. */
const build = (
  products: MenuSourceProduct[],
  items: Record<string, Partial<MenuSourceItem>> = {},
  categoryOrder: MenuSourceCategoryOrder[] = [],
) =>
  buildMenuSnapshot({
    store,
    categories: [
      { _id: 'cat-bolos', name: 'Bolos', icon: 'cake', color: '#f00' },
      { _id: 'cat-doces', name: 'Doces' },
      { _id: 'cat-bebidas', name: 'Bebidas' },
    ],
    categoryOrder,
    products,
    items: products.map((p) => ({
      productId: p._id,
      active: true,
      ...items[String(p._id)],
    })),
    version: 3,
    publishedAt: new Date('2026-10-16T12:00:00Z'),
  });

describe('buildMenuSnapshot', () => {
  it('só publica produtos ligados no cardápio, ativos e com preço', () => {
    const snap = build(
      [
        product({ _id: 'ok', name: 'Ok' }),
        product({ _id: 'oculto' }),
        product({ _id: 'inativo', isActive: false }),
        product({
          _id: 'canal-off',
          prices: { ordemBee: { value: 10, active: false } },
        }),
        product({
          _id: 'sem-preco',
          prices: { ordemBee: { value: 0, active: true } },
        }),
      ],
      { oculto: { active: false } },
    );
    const ids = snap.categories.flatMap((c) => c.products.map((p) => p.id));
    expect(ids).toEqual(['ok']);
  });

  it('preço: OrdemBee ativo, senão o de Caixa; sem nenhum, fica fora', () => {
    const snap = build([
      product({
        _id: 'ordembee',
        prices: {
          caixa: { value: 8 },
          ordemBee: { value: 10, active: true },
        },
      }),
      product({
        _id: 'caixa',
        prices: {
          caixa: { value: 8 },
          ordemBee: { value: 10, active: false },
        },
      }),
      product({
        _id: 'nada',
        prices: {
          caixa: { value: 0 },
          ordemBee: { value: 0, active: false },
        },
      }),
    ]);
    const prices = Object.fromEntries(
      snap.categories.flatMap((c) => c.products.map((p) => [p.id, p.price])),
    );
    expect(prices).toEqual({ ordembee: 10, caixa: 8 });
  });

  it('não vaza custo, estoque nem precificação', () => {
    const snap = build([
      product({ costPrice: 4, pricingId: 'x', stock: 7 } as any),
    ]);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/costPrice|pricing|stock|custo/i);
    expect(Object.keys(snap.categories[0].products[0]).sort()).toEqual(
      [
        'available',
        'description',
        'id',
        'imageUrl',
        'name',
        'optionGroups',
        'price',
      ].sort(),
    );
  });

  it('marca esgotado só quando o estoque é controlado e zerado', () => {
    const snap = build([
      product({ _id: 'zerado', stock: 0 }),
      product({ _id: 'negativo', stock: -4 }),
      product({ _id: 'sem-controle', stock: -1 }),
      product({ _id: 'combo', stock: 0, isCombo: true }),
    ]);
    const available = Object.fromEntries(
      snap.categories[0].products.map((p) => [p.id, p.available]),
    );
    expect(available).toEqual({
      zerado: false,
      negativo: false,
      'sem-controle': true,
      combo: true,
    });
  });

  it('agrupa por categoria, produtos por nome e manda "Outros" por último', () => {
    const snap = build([
      product({ _id: 'b', name: 'B' }),
      product({ _id: 'a', name: 'A' }),
      product({ _id: 'c', name: 'C' }),
      product({ _id: 'solto', categoryId: undefined }),
      product({ _id: 'doce', categoryId: 'cat-doces' }),
    ]);
    expect(snap.categories.map((c) => c.name)).toEqual([
      'Bolos',
      'Doces',
      'Outros',
    ]);
    expect(snap.categories[0].products.map((p) => p.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('categorias seguem a ordem do cardápio; sem posição vêm depois, por nome', () => {
    const snap = build(
      [
        product({ _id: 'bolo', categoryId: 'cat-bolos' }),
        product({ _id: 'doce', categoryId: 'cat-doces' }),
        product({ _id: 'suco', categoryId: 'cat-bebidas' }),
        product({ _id: 'solto', categoryId: undefined }),
      ],
      {},
      [
        { categoryId: 'cat-doces', order: 0 },
        { categoryId: 'cat-bebidas', order: 1 },
      ],
    );
    expect(snap.categories.map((c) => c.name)).toEqual([
      'Doces',
      'Bebidas',
      'Bolos',
      'Outros',
    ]);
  });

  it('hash ignora versão e data de publicação', () => {
    const a = build([product({ _id: 'x' })]);
    const b = { ...a, version: 99, publishedAt: 'outra' };
    expect(snapshotContentHash(a)).toBe(snapshotContentHash(b));
  });
});

describe('horário de funcionamento', () => {
  const tz = 'America/Sao_Paulo';
  // 2026-10-16 é sexta (5). 15:00 em SP = 18:00Z.
  const at = (iso: string) => new Date(iso);

  it('valida o formato', () => {
    expect(isValidOpeningHours({ '1': ['11:00', '23:00'], '2': null })).toBe(
      true,
    );
    expect(isValidOpeningHours({ '7': ['11:00', '23:00'] })).toBe(false);
    expect(isValidOpeningHours({ '1': ['25:00', '23:00'] })).toBe(false);
    expect(isValidOpeningHours({ '1': ['10:00', '10:00'] })).toBe(false);
  });

  it('aberto dentro do turno, no fuso da loja', () => {
    const hours = { '5': ['11:00', '23:00'] as [string, string] };
    expect(isOpenAt(hours, tz, at('2026-10-16T18:00:00Z'))).toBe(true); // 15:00
    expect(isOpenAt(hours, tz, at('2026-10-16T13:30:00Z'))).toBe(false); // 10:30
  });

  it('turno que passa da meia-noite cobre a madrugada do dia seguinte', () => {
    const hours = { '5': ['18:00', '02:00'] as [string, string], '6': null };
    expect(isOpenAt(hours, tz, at('2026-10-17T04:30:00Z'))).toBe(true); // sáb 01:30
    expect(isOpenAt(hours, tz, at('2026-10-17T05:30:00Z'))).toBe(false); // sáb 02:30
  });

  it('sem horário configurado = fechado', () => {
    expect(isOpenAt({}, tz, at('2026-10-16T18:00:00Z'))).toBe(false);
  });
});

describe('complementos — resolveOptionGroups', () => {
  const groups = [
    {
      _id: 'g-bebida',
      name: 'Bebida',
      min: 0,
      max: 3,
      options: [
        { _id: 'coca', name: 'Coca 350ml', price: 7.9 },
        { _id: 'guara', name: 'Guaravita', price: 2.9, active: false },
      ],
    },
    {
      _id: 'g-vazio',
      name: 'Vazio',
      options: [{ _id: 'x', name: 'X', active: false }],
    },
    {
      _id: 'g-off',
      name: 'Desligado',
      active: false,
      options: [{ _id: 'y', name: 'Y' }],
    },
    {
      _id: 'g-desc',
      name: 'Descartáveis',
      min: 5,
      max: 1,
      options: [
        { _id: 'colher', name: 'Colher', price: 0.9 },
        { _id: 'nao', name: 'Não preciso', price: 0 },
      ],
    },
  ];

  it('usa a ordem do item, só grupos/opções ativos e normaliza min/max', () => {
    const resolved = resolveOptionGroups(
      {
        productId: 'p',
        optionGroupIds: [
          'g-desc',
          'g-off',
          'g-vazio',
          'g-bebida',
          'nao-existe',
        ],
      },
      groups,
    );
    expect(resolved).toEqual([
      {
        id: 'g-desc',
        name: 'Descartáveis',
        min: 1, // min 5 > max 1: cai para o max
        max: 1,
        options: [
          { id: 'colher', name: 'Colher', price: 0.9 },
          { id: 'nao', name: 'Não preciso', price: 0 },
        ],
      },
      {
        id: 'g-bebida',
        name: 'Bebida',
        min: 0,
        max: 1,
        options: [{ id: 'coca', name: 'Coca 350ml', price: 7.9 }],
      },
    ]);
  });

  it('produto publicado leva os complementos do item', () => {
    const snap = buildMenuSnapshot({
      store,
      categories: [],
      products: [product({ _id: 'p1' })],
      items: [
        {
          productId: 'p1',
          active: true,
          optionGroupIds: ['g-bebida'],
        },
      ],
      optionGroups: groups,
      version: 1,
      publishedAt: new Date(),
    });
    expect(
      snap.categories[0].products[0].optionGroups.map((g) => g.id),
    ).toEqual(['g-bebida']);
  });
});

describe('disponibilidade (nunca o número)', () => {
  it('ok sem controle, low até 3, out em zero ou negativo', () => {
    expect(availabilityLevel(product({ stock: -1 }))).toBe('ok');
    expect(availabilityLevel(product({ stock: 10 }))).toBe('ok');
    expect(availabilityLevel(product({ stock: 3 }))).toBe('low');
    expect(availabilityLevel(product({ stock: 1 }))).toBe('low');
    expect(availabilityLevel(product({ stock: 0 }))).toBe('out');
    expect(availabilityLevel(product({ stock: -4 }))).toBe('out');
  });

  it('combo mede pelos componentes controlados', () => {
    const combo = product({
      isCombo: true,
      comboItems: [
        { productId: 'doce', quantity: 2 },
        { productId: 'caixa', quantity: 1 },
      ],
    });
    const stocks = new Map([
      ['doce', 5],
      ['caixa', -1],
    ]);
    // 5 doces / 2 por combo = 2 combos -> "últimas unidades"
    expect(availabilityLevel(combo, stocks)).toBe('low');
    expect(isProductAvailable(combo, new Map([['doce', 1]]))).toBe(false);
    // Sem estoque conhecido dos componentes, não bloqueia.
    expect(isProductAvailable(combo)).toBe(true);
  });

  it('hash muda com descrição, foto, disponibilidade e preço (tudo só vai ao ar publicando)', () => {
    const base = build([product({ _id: 'a', description: 'x', stock: 5 })]);
    const edits = [
      product({ _id: 'a', description: 'y', stock: 5 }),
      product({ _id: 'a', description: 'x', imageUrl: 'https://z', stock: 5 }),
      product({ _id: 'a', description: 'x', stock: 0 }),
      product({
        _id: 'a',
        description: 'x',
        stock: 5,
        prices: { ordemBee: { value: 11, active: true } },
      }),
    ];
    for (const edited of edits) {
      expect(snapshotContentHash(build([edited]))).not.toBe(
        snapshotContentHash(base),
      );
    }
    // Vender sem esgotar não pede publicar (o snapshot só guarda "disponível").
    expect(
      snapshotContentHash(
        build([product({ _id: 'a', description: 'x', stock: 4 })]),
      ),
    ).toBe(snapshotContentHash(base));
  });
});
