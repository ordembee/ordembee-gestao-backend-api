import {
  availabilityLevel,
  buildLiveProducts,
  buildMenuSnapshot,
  isProductAvailable,
  snapshotContentHash,
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
  pickupEnabled: true,
  openingHours: {},
  instagram: '',
  themeColor: null,
  acceptedPayments: ['PIX'],
};

const product = (over: Partial<MenuSourceProduct> = {}): MenuSourceProduct => ({
  _id: over._id ?? Math.random().toString(16).slice(2),
  name: 'Bolo',
  categoryId: 'cat-bolos',
  isActive: true,
  stock: -1,
  prices: { deliveryProprio: { value: 10, active: true } },
  ...over,
});

/** Por padrao todo produto esta ativo no cardapio (ordem 0); `items` sobrescreve por id. */
const build = (
  products: MenuSourceProduct[],
  items: Record<string, Partial<MenuSourceItem>> = {},
) =>
  buildMenuSnapshot({
    store,
    categories: [
      { _id: 'cat-bolos', name: 'Bolos', icon: 'cake', color: '#f00' },
      { _id: 'cat-doces', name: 'Doces' },
    ],
    products,
    items: products.map((p) => ({
      productId: p._id,
      active: true,
      order: 0,
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
          prices: { deliveryProprio: { value: 10, active: false } },
        }),
        product({
          _id: 'sem-preco',
          prices: { deliveryProprio: { value: 0, active: true } },
        }),
      ],
      { oculto: { active: false } },
    );
    const ids = snap.categories.flatMap((c) => c.products.map((p) => p.id));
    expect(ids).toEqual(['ok']);
  });

  it('preço: Delivery próprio ativo, senão o de Caixa; sem nenhum, fica fora', () => {
    const snap = build([
      product({
        _id: 'delivery',
        prices: {
          caixa: { value: 8 },
          deliveryProprio: { value: 10, active: true },
        },
      }),
      product({
        _id: 'caixa',
        prices: {
          caixa: { value: 8 },
          deliveryProprio: { value: 10, active: false },
        },
      }),
      product({
        _id: 'nada',
        prices: {
          caixa: { value: 0 },
          deliveryProprio: { value: 0, active: false },
        },
      }),
    ]);
    const prices = Object.fromEntries(
      snap.categories.flatMap((c) => c.products.map((p) => [p.id, p.price])),
    );
    expect(prices).toEqual({ delivery: 10, caixa: 8 });
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
        'tag',
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

  it('agrupa por categoria, ordena pela ordem do cardápio/nome e manda "Outros" por último', () => {
    const snap = build(
      [
        product({ _id: 'b', name: 'B' }),
        product({ _id: 'a', name: 'A' }),
        product({ _id: 'c', name: 'C' }),
        product({ _id: 'solto', categoryId: undefined }),
        product({ _id: 'doce', categoryId: 'cat-doces' }),
      ],
      {
        b: { order: 2 },
        a: { order: 2 },
        c: { order: 1 },
        solto: { order: -5 },
        doce: { order: 5 },
      },
    );
    expect(snap.categories.map((c) => c.name)).toEqual([
      'Bolos',
      'Doces',
      'Outros',
    ]);
    expect(snap.categories[0].products.map((p) => p.id)).toEqual([
      'c',
      'a',
      'b',
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
          order: 0,
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

  it('ao vivo só leva disponibilidade, descrição e foto de quem está no cardápio', () => {
    const on = product({ _id: 'a', stock: 0, description: 'Novo texto', imageUrl: 'https://x/y.webp' });
    const off = product({ _id: 'b' });
    const live = buildLiveProducts({
      products: [on, off],
      items: [
        { productId: 'a', active: true },
        { productId: 'b', active: false },
      ],
    });
    expect(Object.keys(live)).toEqual(['a']);
    expect(live.a).toEqual({ availability: 'out', description: 'Novo texto', imageUrl: 'https://x/y.webp' });
    expect(JSON.stringify(live)).not.toMatch(/price|name|stock/);
  });

  it('hash ignora descrição, foto e disponibilidade (vão ao ar sozinhas), mas não o preço', () => {
    const base = build([product({ _id: 'a', description: 'x', stock: 5 })]);
    const editedLive = build([product({ _id: 'a', description: 'y', imageUrl: 'https://z', stock: 0 })]);
    const editedPrice = build([
      product({ _id: 'a', description: 'x', stock: 5, prices: { deliveryProprio: { value: 11, active: true } } }),
    ]);
    expect(snapshotContentHash(editedLive)).toBe(snapshotContentHash(base));
    expect(snapshotContentHash(editedPrice)).not.toBe(snapshotContentHash(base));
  });
});
