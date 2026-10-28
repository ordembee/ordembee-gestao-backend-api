import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { MenuService } from './menu.service';

const chain = (value: unknown) => ({
  select: () => chain(value),
  lean: () => chain(value),
  exec: () => Promise.resolve(value),
});

/**
 * Service cru: Business so com o que e do negocio, o cardapio (MenuOnline)
 * num model a parte. `updateOne` do cardapio guarda o que foi gravado.
 */
function makeService(
  opts: {
    business?: Record<string, unknown>;
    menu?: Record<string, unknown> | null;
    product?: any;
    products?: any[];
    categories?: any[];
    storage?: any;
  } = {},
) {
  const business = {
    _id: new Types.ObjectId(),
    name: 'Loja',
    ...opts.business,
  };
  const menuUpdate = jest.fn(() => ({ exec: () => Promise.resolve() }));
  const menuModel = {
    findOne: () => chain(opts.menu ?? null),
    exists: jest.fn(() => chain(null)),
    updateOne: menuUpdate,
  };
  const productModel = {
    findOne: () => ({ exec: () => Promise.resolve(opts.product ?? null) }),
    find: () => chain(opts.products ?? []),
    countDocuments: jest.fn(() => chain(1)),
  };
  const categoryModel = {
    find: () => chain(opts.categories ?? []),
    countDocuments: jest.fn(() => chain(1)),
  };
  const service = new MenuService(
    { findById: () => chain(business) } as any,
    menuModel as any,
    productModel as any,
    categoryModel as any,
    (opts.storage ?? {}) as any,
  );
  /** Ultimo `$set`/`$unset` gravado no cardapio. */
  const lastWrite = () => (menuUpdate.mock.calls.at(-1) as any[])[1];
  const saved = (key: string) => lastWrite().$set[key];
  return {
    service,
    businessId: business._id.toString(),
    business,
    menuUpdate,
    lastWrite,
    saved,
    productModel,
    categoryModel,
  };
}

describe('MenuService — itens do cardápio', () => {
  function setup(
    opts: {
      items?: any[];
      channel?: { value: number; active: boolean };
      caixa?: number;
    } = {},
  ) {
    const productId = new Types.ObjectId();
    const product: any = {
      _id: productId,
      name: 'Bolo',
      categoryId: undefined,
      prices: {
        caixa: { value: opts.caixa ?? 0, active: true },
        ordemBee: opts.channel ?? { value: 0, active: false },
      },
      toObject: () => ({ ...product }),
    };
    const ctx = makeService({
      menu: { items: opts.items ?? [] },
      product,
    });
    return { ...ctx, productId };
  }

  it('ligar produto sem nenhum preço cadastrado é recusado', async () => {
    const { service, businessId, productId } = setup();
    await expect(
      service.updateItem(businessId, productId.toString(), { active: true }),
    ).rejects.toThrow(BadRequestException);
  });

  it('sem Delivery próprio, usa o preço de Caixa cadastrado', async () => {
    const { service, businessId, productId, saved } = setup({ caixa: 14 });
    const row = await service.updateItem(businessId, productId.toString(), {
      active: true,
    });
    expect(row).toMatchObject({
      active: true,
      price: 14,
      priceSource: 'caixa',
    });
    expect(row).not.toHaveProperty('tag');
    expect(saved('items')).toEqual([{ productId, active: true }]);
  });

  it('Delivery próprio ativo tem prioridade sobre o Caixa', async () => {
    const { service, businessId, productId } = setup({
      caixa: 14,
      channel: { value: 16.9, active: true },
    });
    const row = await service.updateItem(businessId, productId.toString(), {
      active: true,
    });
    expect(row).toMatchObject({ price: 16.9, priceSource: 'ordembee' });
  });

  it('desligar mantém os complementos guardados', async () => {
    const groupId = new Types.ObjectId();
    const productId = new Types.ObjectId();
    const { service, businessId, saved } = makeService({
      menu: {
        items: [{ productId, active: true, optionGroupIds: [groupId] }],
      },
      product: {
        _id: productId,
        name: 'Bolo',
        prices: { caixa: { value: 10, active: true } },
        toObject() {
          return { ...this };
        },
      },
    });
    await service.updateItem(businessId, productId.toString(), {
      active: false,
    });
    expect(saved('items')[0]).toMatchObject({
      active: false,
      optionGroupIds: [groupId],
    });
  });

  it('lista na ordem das categorias do cardápio, produtos por nome', async () => {
    const doces = new Types.ObjectId();
    const bebidas = new Types.ObjectId();
    const price = { caixa: { value: 5, active: true } };
    const { service, businessId } = makeService({
      menu: {
        categories: [
          { categoryId: doces, order: 0 },
          { categoryId: bebidas, order: 1 },
        ],
      },
      products: [
        {
          _id: new Types.ObjectId(),
          name: 'Suco',
          categoryId: bebidas,
          prices: price,
        },
        { _id: new Types.ObjectId(), name: 'Sem categoria', prices: price },
        {
          _id: new Types.ObjectId(),
          name: 'Brigadeiro',
          categoryId: doces,
          prices: price,
        },
        {
          _id: new Types.ObjectId(),
          name: 'Bolo',
          categoryId: doces,
          prices: price,
        },
      ],
      categories: [
        { _id: bebidas, name: 'Bebidas' },
        { _id: doces, name: 'Doces' },
      ],
    });
    const rows = await service.listItems(businessId);
    expect(rows.map((r) => r.name)).toEqual([
      'Bolo',
      'Brigadeiro',
      'Suco',
      'Sem categoria',
    ]);
  });
});

describe('MenuService — ordem das categorias', () => {
  it('grava a posição de cada categoria na ordem enviada', async () => {
    const { service, businessId, saved, categoryModel } = makeService();
    const [a, b] = [new Types.ObjectId(), new Types.ObjectId()];
    categoryModel.countDocuments.mockReturnValue(chain(2));
    await service.reorderCategories(businessId, {
      categoryIds: [b.toString(), a.toString()],
    });
    expect(
      saved('categories').map((c: any) => [String(c.categoryId), c.order]),
    ).toEqual([
      [b.toString(), 0],
      [a.toString(), 1],
    ]);
  });

  it('categoria de outro negócio é recusada', async () => {
    const { service, businessId, categoryModel } = makeService();
    categoryModel.countDocuments.mockReturnValue(chain(0));
    await expect(
      service.reorderCategories(businessId, {
        categoryIds: [new Types.ObjectId().toString()],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('categoria sem posição definida vem depois, por nome', async () => {
    const [a, b, c] = [
      new Types.ObjectId(),
      new Types.ObjectId(),
      new Types.ObjectId(),
    ];
    const { service, businessId } = makeService({
      menu: { categories: [{ categoryId: c, order: 0 }] },
      categories: [
        { _id: b, name: 'Bebidas' },
        { _id: a, name: 'Antepastos' },
        { _id: c, name: 'Doces' },
      ],
    });
    const rows = await service.listCategories(businessId);
    expect(rows.map((r) => r.name)).toEqual(['Doces', 'Antepastos', 'Bebidas']);
  });
});

describe('MenuService — grupos de complementos', () => {
  const groupSetup = (groups: any[] = [], items: any[] = []) =>
    makeService({ menu: { items, optionGroups: groups } });

  it('cria grupo com ids novos para as opções', async () => {
    const { service, saved, businessId } = groupSetup();
    const row = await service.saveOptionGroup(businessId, null, {
      name: ' Bebidas ',
      min: 0,
      max: 2,
      options: [
        { name: 'Coca', price: 7.9 },
        { name: 'Água', price: 3 },
      ],
    });
    expect(row).toMatchObject({
      name: 'Bebidas',
      min: 0,
      max: 2,
      active: true,
      usedBy: 0,
    });
    expect(row.options.every((o) => /^[0-9a-f]{24}$/.test(o.id))).toBe(true);
    expect(saved('optionGroups')).toHaveLength(1);
  });

  it('ao editar, mantém o id das opções que já eram do grupo', async () => {
    const optionId = new Types.ObjectId();
    const groupId = new Types.ObjectId();
    const { service, businessId } = groupSetup([
      {
        _id: groupId,
        name: 'Bebidas',
        min: 0,
        max: 1,
        options: [{ _id: optionId, name: 'Coca', price: 7 }],
      },
    ]);
    const foreign = new Types.ObjectId().toString();
    const row = await service.saveOptionGroup(businessId, groupId.toString(), {
      name: 'Bebidas',
      min: 0,
      max: 1,
      options: [
        { id: optionId.toString(), name: 'Coca', price: 7.9 },
        { id: foreign, name: 'Suco', price: 5 }, // id de fora do grupo: vira id novo
      ],
    });
    expect(row.options[0].id).toBe(optionId.toString());
    expect(row.options[1].id).not.toBe(foreign);
  });

  it('mínimo maior que máximo é recusado', async () => {
    const { service, businessId } = groupSetup();
    await expect(
      service.saveOptionGroup(businessId, null, {
        name: 'X',
        min: 2,
        max: 1,
        options: [{ name: 'a', price: 0 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('remover grupo tira ele dos itens que usavam', async () => {
    const groupId = new Types.ObjectId();
    const keep = new Types.ObjectId();
    const { service, saved, businessId } = groupSetup(
      [
        { _id: groupId, name: 'A', options: [] },
        { _id: keep, name: 'B', options: [] },
      ],
      [
        {
          productId: new Types.ObjectId(),
          active: true,
          optionGroupIds: [groupId, keep],
        },
      ],
    );
    await service.removeOptionGroup(businessId, groupId.toString());
    expect(saved('optionGroups').map((g: any) => String(g._id))).toEqual([
      keep.toString(),
    ]);
    expect(saved('items')[0].optionGroupIds.map(String)).toEqual([
      keep.toString(),
    ]);
  });
});

describe('MenuService — logo e capa', () => {
  const BUCKET = 'https://storage.googleapis.com/bucket/';
  const storage = () => ({
    uploadStoreImage: jest.fn(async (_b: string, kind: string) => ({
      url: `${BUCKET}business/x/menu/${kind}-1.webp`,
      path: `business/x/menu/${kind}-1.webp`,
    })),
    pathFromPublicUrl: (url?: string) =>
      url?.startsWith(BUCKET) ? url.slice(BUCKET.length) : null,
    deleteFile: jest.fn(async () => undefined),
    publicUrl: (p: string) => BUCKET + p,
  });
  const file = { mimetype: 'image/png', buffer: Buffer.from('x') } as any;

  it('logo nova é do cardápio (store.images) e apaga a anterior do nosso Storage', async () => {
    const st = storage();
    const { service, businessId, lastWrite } = makeService({
      menu: {
        store: { images: { logoUrl: `${BUCKET}business/x/menu/logo-0.webp` } },
      },
      storage: st,
    });
    await service.setStoreImage(businessId, 'logo', file);
    expect(lastWrite()).toEqual({
      $set: {
        'store.images.logoUrl': `${BUCKET}business/x/menu/logo-1.webp`,
      },
    });
    expect(st.deleteFile).toHaveBeenCalledWith('business/x/menu/logo-0.webp');
  });

  it('não apaga a logo herdada que ainda é a do negócio', async () => {
    const st = storage();
    const shared = `${BUCKET}business/x/logo.webp`;
    const { service, businessId } = makeService({
      business: { logoUrl: shared },
      menu: { store: { images: { logoUrl: shared } } },
      storage: st,
    });
    await service.setStoreImage(businessId, 'logo', file);
    expect(st.deleteFile).not.toHaveBeenCalled();
  });

  it('capa vai para store.images.coverUrl e não apaga URL externa', async () => {
    const st = storage();
    const { service, businessId, lastWrite } = makeService({
      menu: {
        store: { images: { coverUrl: 'https://outro-site.com/capa.jpg' } },
      },
      storage: st,
    });
    await service.setStoreImage(businessId, 'cover', file);
    expect(lastWrite()).toEqual({
      $set: {
        'store.images.coverUrl': `${BUCKET}business/x/menu/cover-1.webp`,
      },
    });
    expect(st.deleteFile).not.toHaveBeenCalled();
  });

  it('remover tira o campo e apaga o arquivo', async () => {
    const st = storage();
    const { service, businessId, lastWrite } = makeService({
      menu: {
        store: { images: { logoUrl: `${BUCKET}business/x/menu/logo-0.webp` } },
      },
      storage: st,
    });
    await service.removeStoreImage(businessId, 'logo');
    expect(lastWrite()).toEqual({ $unset: { 'store.images.logoUrl': '' } });
    expect(st.deleteFile).toHaveBeenCalledWith('business/x/menu/logo-0.webp');
  });
});

describe('MenuService — configurações', () => {
  it('não deixa desligar entrega e retirada ao mesmo tempo', async () => {
    const { service, businessId } = makeService({
      menu: { store: { delivery: { pickupEnabled: false } } },
    });
    await expect(
      service.updateSettings(businessId, {
        store: { delivery: { deliveryEnabled: false } },
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('grava cada campo no seu caminho, sem apagar os irmãos', async () => {
    const storage = { publicUrl: (p: string) => p };
    const { service, businessId, lastWrite } = makeService({ storage });
    await service.updateSettings(businessId, {
      enabled: true,
      store: {
        delivery: { deliveryFee: 7 },
        openingHours: { '1': ['09:00', '18:00'] },
        acceptedPayments: ['PIX'],
      },
      labelText: { highlightTitle: 'Oi' },
    });
    expect(lastWrite()).toEqual({
      $set: {
        enabled: true,
        'store.delivery.deliveryFee': 7,
        'store.openingHours': { '1': ['09:00', '18:00'] },
        'store.acceptedPayments': ['PIX'],
        'labelText.highlightTitle': 'Oi',
      },
    });
  });
});

describe('MenuService — cor da marca no JSON publicado', () => {
  const previewWith = async (themeColor?: string) => {
    const { service, businessId } = makeService({
      menu: { store: { colors: { themeColor } } },
    });
    return (await service.preview(businessId)).store.themeColor;
  };

  it('publica a cor em minúsculas', async () => {
    expect(await previewWith('#1FAA59')).toBe('#1faa59');
  });

  it.each([undefined, '', 'vermelho', '#123'])(
    'sem cor válida (%p) publica null',
    async (value) => {
      expect(await previewWith(value)).toBeNull();
    },
  );
});

describe('MenuService — troca de slug', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const storage = () => ({
    publicUrl: (p: string) => p,
    uploadPublicJson: jest.fn(async (p: string) => p),
    deleteFileIfOwner: jest.fn(async () => true),
    deleteFileIfNotOwner: jest.fn(async () => true),
  });

  it('recusa endereço reservado', async () => {
    const { service, businessId } = makeService({ storage: storage() });
    await expect(
      service.updateSettings(businessId, { slug: 'admin' }),
    ).rejects.toThrow('não está disponível');
  });

  it('recusa slug de outro negócio', async () => {
    const { service, businessId } = makeService({ storage: storage() });
    (service as any).menuModel.exists.mockReturnValue(chain({ _id: 1 }));
    await expect(
      service.updateSettings(businessId, { slug: 'tia-nana' }),
    ).rejects.toThrow('já está em uso');
  });

  it('indice unico (corrida) vira conflito, não erro 500', async () => {
    const { service, businessId, menuUpdate } = makeService({
      storage: storage(),
    });
    menuUpdate.mockImplementation(() => ({
      exec: () => Promise.reject({ code: 11000 }),
    }));
    await expect(
      service.updateSettings(businessId, { slug: 'tia-nana' }),
    ).rejects.toThrow('já está em uso');
  });

  it('cardápio no ar: respeita o intervalo entre trocas', async () => {
    const { service, businessId } = makeService({
      storage: storage(),
      menu: {
        slug: 'antigo',
        slugChangedAt: new Date(Date.now() - 5 * DAY),
        publication: { slug: 'antigo', version: 1 },
      },
    });
    await expect(
      service.updateSettings(businessId, { slug: 'novo' }),
    ).rejects.toThrow('a cada 30 dias');
  });

  it('sem link no ar a troca é livre e não conta no intervalo', async () => {
    const { service, businessId, lastWrite } = makeService({
      storage: storage(),
      menu: { slug: 'antigo' },
    });
    await service.updateSettings(businessId, { slug: 'novo' });
    expect(lastWrite().$set).toEqual({ slug: 'novo' });
  });

  it('cardápio no ar: grava a troca e republica no endereço novo', async () => {
    const st = storage();
    const { service, businessId, saved } = makeService({
      storage: st,
      menu: {
        slug: 'antigo',
        enabled: true,
        publication: { slug: 'antigo', version: 1 },
      },
    });
    const publish = jest
      .spyOn(service, 'publish')
      .mockResolvedValue({} as never);
    await service.updateSettings(businessId, { slug: 'novo' });
    expect(saved('slug')).toBe('novo');
    expect(publish).toHaveBeenCalledWith(businessId);
  });

  it('republicar falhou: tira o endereço antigo do ar, só se for do negócio', async () => {
    const st = storage();
    const { service, businessId, business, saved } = makeService({
      storage: st,
      menu: {
        slug: 'antigo',
        enabled: true,
        publication: { slug: 'antigo', version: 1 },
      },
    });
    jest.spyOn(service, 'publish').mockRejectedValue(new Error('sem produtos'));
    await expect(
      service.updateSettings(businessId, { slug: 'novo' }),
    ).rejects.toThrow('sem produtos');
    expect(st.deleteFileIfOwner).toHaveBeenCalledWith(
      'menus/antigo.json',
      business._id.toString(),
    );
    expect(saved('publication.slug')).toBeNull();
  });

  it('desligar o cardápio apaga o arquivo conferindo o dono', async () => {
    const st = storage();
    const { service, businessId, business } = makeService({
      storage: st,
      menu: { slug: 'tia', enabled: true, publication: { slug: 'tia' } },
    });
    await service.updateSettings(businessId, { enabled: false });
    expect(st.deleteFileIfOwner).toHaveBeenCalledWith(
      'menus/tia.json',
      business._id.toString(),
    );
  });

  it('ao assumir um slug, apaga o arquivo que sobrou de outro dono', async () => {
    const st = storage();
    const { service, businessId, business } = makeService({
      storage: st,
      menu: { slug: 'antigo' },
    });
    await service.updateSettings(businessId, { slug: 'tia-nana' });
    expect(st.deleteFileIfNotOwner).toHaveBeenCalledWith(
      'menus/tia-nana.json',
      business._id.toString(),
    );
  });

  it('não apaga se outro cardápio ainda o tem como publicado', async () => {
    const st = storage();
    const { service, businessId } = makeService({
      storage: st,
      menu: { slug: 'antigo' },
    });
    (service as any).menuModel.exists
      .mockReturnValueOnce(chain(null)) // ninguem tem como slug
      .mockReturnValueOnce(chain({ _id: 1 })); // alguem ainda publica nele
    await service.updateSettings(businessId, { slug: 'tia-nana' });
    expect(st.deleteFileIfNotOwner).not.toHaveBeenCalled();
  });
});
