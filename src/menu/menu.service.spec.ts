import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { MenuService } from './menu.service';

/** Service cru com mocks do que updateItem/reorderItems tocam. */
function setup(
  opts: {
    items?: any[];
    channel?: { value: number; active: boolean };
    caixa?: number;
    onMenu?: boolean;
  } = {},
) {
  const businessId = new Types.ObjectId();
  const productId = new Types.ObjectId();
  const product: any = {
    _id: productId,
    name: 'Bolo',
    categoryId: undefined,
    prices: {
      caixa: { value: opts.caixa ?? 0, active: true },
      deliveryProprio: opts.channel ?? { value: 0, active: false },
    },
    toObject: () => ({ ...product }),
  };
  const items = opts.onMenu
    ? [{ productId, active: true, order: 0 }]
    : (opts.items ?? []);
  const business = { _id: businessId, name: 'Loja', menu: { items } };
  const updateOne = jest.fn(() => ({ exec: () => Promise.resolve() }));
  const businessModel = {
    findById: () => ({
      select: () => ({
        lean: () => ({ exec: () => Promise.resolve(business) }),
      }),
    }),
    updateOne,
  };
  const productModel = {
    findOne: () => ({ exec: () => Promise.resolve(product) }),
    countDocuments: jest.fn(() => ({ exec: () => Promise.resolve(1) })),
  };
  const service = new MenuService(
    businessModel as any,
    productModel as any,
    {} as any,
    {} as any,
  );
  const savedItems = () =>
    (updateOne.mock.calls.at(-1) as any[])[1].$set['menu.items'];
  return {
    service,
    product,
    productId,
    businessId: businessId.toString(),
    savedItems,
    productModel,
  };
}

describe('MenuService — itens do cardápio', () => {
  it('ligar produto sem nenhum preço cadastrado é recusado', async () => {
    const { service, businessId, productId } = setup();
    await expect(
      service.updateItem(businessId, productId.toString(), { active: true }),
    ).rejects.toThrow(BadRequestException);
  });

  it('sem Delivery próprio, usa o preço de Caixa cadastrado', async () => {
    const { service, businessId, productId, savedItems } = setup({ caixa: 14 });
    const row = await service.updateItem(businessId, productId.toString(), {
      active: true,
      tag: ' Mais pedido ',
    });
    expect(row).toMatchObject({
      active: true,
      price: 14,
      priceSource: 'caixa',
      tag: 'Mais pedido',
    });
    expect(savedItems()).toEqual([
      expect.objectContaining({
        productId,
        active: true,
        tag: 'Mais pedido',
        order: 0,
      }),
    ]);
  });

  it('Delivery próprio ativo tem prioridade sobre o Caixa', async () => {
    const { service, businessId, productId } = setup({
      caixa: 14,
      channel: { value: 16.9, active: true },
    });
    const row = await service.updateItem(businessId, productId.toString(), {
      active: true,
    });
    expect(row).toMatchObject({ price: 16.9, priceSource: 'delivery' });
  });

  it('desligar mantém selo e ordem guardados', async () => {
    const { service, businessId, productId, savedItems } = setup({
      caixa: 10,
      onMenu: true,
    });
    await service.updateItem(businessId, productId.toString(), {
      active: false,
    });
    expect(savedItems()[0]).toMatchObject({ active: false, order: 0 });
  });

  it('reordenar grava a posição de cada produto e mantém o estado', async () => {
    const { service, businessId, productId, savedItems, productModel } = setup({
      items: [],
    });
    const other = new Types.ObjectId();
    productModel.countDocuments.mockReturnValue({
      exec: () => Promise.resolve(2),
    });
    await service.reorderItems(businessId, {
      productIds: [other.toString(), productId.toString()],
    });
    expect(
      savedItems().map((i: any) => [String(i.productId), i.order, i.active]),
    ).toEqual([
      [other.toString(), 0, false],
      [productId.toString(), 1, false],
    ]);
  });

  it('reordenar com produto de outro negócio é recusado', async () => {
    const { service, businessId, productModel } = setup();
    productModel.countDocuments.mockReturnValue({
      exec: () => Promise.resolve(0),
    });
    await expect(
      service.reorderItems(businessId, {
        productIds: [new Types.ObjectId().toString()],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('MenuService — grupos de complementos', () => {
  function groupSetup(groups: any[] = [], items: any[] = []) {
    const updateOne = jest.fn(() => ({ exec: () => Promise.resolve() }));
    const business = {
      _id: new Types.ObjectId(),
      name: 'Loja',
      menu: { items, optionGroups: groups },
    };
    const service = new MenuService(
      {
        findById: () => ({
          select: () => ({
            lean: () => ({ exec: () => Promise.resolve(business) }),
          }),
        }),
        updateOne,
      } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const saved = (key: string) =>
      (updateOne.mock.calls.at(-1) as any[])[1].$set[key];
    return { service, saved, businessId: business._id.toString() };
  }

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
    expect(saved('menu.optionGroups')).toHaveLength(1);
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
          order: 0,
          optionGroupIds: [groupId, keep],
        },
      ],
    );
    await service.removeOptionGroup(businessId, groupId.toString());
    expect(saved('menu.optionGroups').map((g: any) => String(g._id))).toEqual([
      keep.toString(),
    ]);
    expect(saved('menu.items')[0].optionGroupIds.map(String)).toEqual([
      keep.toString(),
    ]);
  });
});

describe('MenuService — logo e capa', () => {
  const BUCKET = 'https://storage.googleapis.com/bucket/';
  function imageSetup(business: any) {
    const updateOne = jest.fn(() => ({ exec: () => Promise.resolve() }));
    const storage = {
      uploadStoreImage: jest.fn(async (_b: string, kind: string) => ({
        url: `${BUCKET}business/x/menu/${kind}-1.webp`,
        path: `business/x/menu/${kind}-1.webp`,
      })),
      pathFromPublicUrl: (url?: string) =>
        url?.startsWith(BUCKET) ? url.slice(BUCKET.length) : null,
      deleteFile: jest.fn(async () => undefined),
      publicUrl: (p: string) => BUCKET + p,
    };
    const service = new MenuService(
      {
        findById: () => ({
          select: () => ({
            lean: () => ({ exec: () => Promise.resolve(business) }),
          }),
        }),
        updateOne,
      } as any,
      {
        find: () => ({
          select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
        }),
      } as any,
      {
        find: () => ({
          select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
        }),
      } as any,
      storage as any,
    );
    return { service, storage, updateOne };
  }
  const file = { mimetype: 'image/png', buffer: Buffer.from('x') } as any;

  it('logo nova vai para Business.logoUrl e apaga a anterior do nosso Storage', async () => {
    const business = {
      _id: new Types.ObjectId(),
      name: 'Loja',
      logoUrl: `${BUCKET}business/x/menu/logo-0.webp`,
      menu: {},
    };
    const { service, storage, updateOne } = imageSetup(business);
    await service.setStoreImage(String(business._id), 'logo', file);
    expect((updateOne.mock.calls[0] as any[])[1]).toEqual({
      $set: { logoUrl: `${BUCKET}business/x/menu/logo-1.webp` },
    });
    expect(storage.deleteFile).toHaveBeenCalledWith(
      'business/x/menu/logo-0.webp',
    );
  });

  it('capa vai para menu.coverUrl e não apaga URL externa', async () => {
    const business = {
      _id: new Types.ObjectId(),
      name: 'Loja',
      menu: { coverUrl: 'https://outro-site.com/capa.jpg' },
    };
    const { service, storage, updateOne } = imageSetup(business);
    await service.setStoreImage(String(business._id), 'cover', file);
    expect((updateOne.mock.calls[0] as any[])[1]).toEqual({
      $set: { 'menu.coverUrl': `${BUCKET}business/x/menu/cover-1.webp` },
    });
    expect(storage.deleteFile).not.toHaveBeenCalled();
  });

  it('remover tira o campo e apaga o arquivo', async () => {
    const business = {
      _id: new Types.ObjectId(),
      name: 'Loja',
      logoUrl: `${BUCKET}business/x/menu/logo-0.webp`,
      menu: {},
    };
    const { service, storage, updateOne } = imageSetup(business);
    await service.removeStoreImage(String(business._id), 'logo');
    expect((updateOne.mock.calls[0] as any[])[1]).toEqual({
      $unset: { logoUrl: '' },
    });
    expect(storage.deleteFile).toHaveBeenCalledWith(
      'business/x/menu/logo-0.webp',
    );
  });
});

describe('MenuService — entrega e retirada', () => {
  it('não deixa desligar entrega e retirada ao mesmo tempo', async () => {
    const business = {
      _id: new Types.ObjectId(),
      name: 'Loja',
      menu: { pickupEnabled: false },
    };
    const service = new MenuService(
      {
        findById: () => ({
          select: () => ({
            lean: () => ({ exec: () => Promise.resolve(business) }),
          }),
        }),
        updateOne: jest.fn(),
      } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(
      service.updateSettings(String(business._id), { deliveryEnabled: false }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('MenuService — cor da marca no JSON publicado', () => {
  const previewWith = async (themeColor?: string) => {
    const business = {
      _id: new Types.ObjectId(),
      name: 'Loja',
      menu: { themeColor, items: [] },
    };
    const empty = {
      find: () => ({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
      }),
    };
    const service = new MenuService(
      {
        findById: () => ({
          select: () => ({
            lean: () => ({ exec: () => Promise.resolve(business) }),
          }),
        }),
      } as any,
      empty as any,
      empty as any,
      {} as any,
    );
    return (await service.preview(String(business._id))).store.themeColor;
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
