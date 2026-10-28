import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Business,
  BusinessDocument,
} from '../business/schemas/business.schema';
import {
  DeliveryProvider,
  MenuItem,
  MenuOnline,
  MenuOnlineDocument,
  MenuOptionGroup,
} from './schemas/menu-online.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Category,
  CategoryDocument,
} from '../categories/schemas/category.schema';
import { StorageService } from '../storage/storage.service';
import { resolveTimeZone } from '../common/date/timezone.util';
import { UpdateMenuSettingsDto } from './dto/update-menu-settings.dto';
import { MENU_PAYMENT_METHODS } from './dto/menu-order.dto';
import { SaveOptionGroupDto } from './dto/option-group.dto';
import {
  ReorderMenuCategoriesDto,
  UpdateMenuItemDto,
} from './dto/menu-items.dto';
import {
  MENU_PRODUCT_FIELDS,
  MenuSnapshot,
  MenuSourceCategory,
  MenuSourceProduct,
  OTHER_CATEGORY_ID,
  StockIndex,
  buildMenuSnapshot,
  categoryRank,
  comboComponentIds,
  indexMenuItems,
  isProductAvailable,
  menuPrice,
  snapshotContentHash,
} from './menu-snapshot';

export const menuFilePath = (slug: string) => `menus/${slug}.json`;

/** Intervalo minimo entre trocas de slug de um cardapio ja publicado. */
export const SLUG_CHANGE_COOLDOWN_DAYS = 30;

/** Enderecos que nao podem virar slug (rotas e nomes que o produto usa ou pode usar). */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'cardapio',
  'login',
  'menus',
  'ordembee',
  's',
  'static',
  'suporte',
  'www',
]);

/** Erro de chave duplicada do Mongo (indice unico do slug). */
const isDuplicateKey = (err: unknown) =>
  (err as { code?: number })?.code === 11000;

/** Cardapio do negocio com todos os campos preenchidos (documento pode nem existir ainda). */
export type ResolvedMenu = Omit<
  MenuOnline,
  'businessId' | 'store' | 'labelText' | 'publication'
> & {
  store: {
    acceptedPayments: string[];
    delivery: {
      deliveryProvider: DeliveryProvider;
      deliveryFee: number;
      deliveryEnabled: boolean;
      pickupEnabled: boolean;
    };
    contact: { address: string; whatsapp: string };
    socialMedia: { instagram: string };
    images: { coverUrl: string | null; logoUrl: string | null };
    colors: { themeColor: string };
    openingHours: MenuOnline['store']['openingHours'];
  };
  labelText: {
    description: string;
    highlightLabel: string;
    highlightTitle: string;
  };
  publication: {
    version: number;
    lastPublishedAt: Date | null;
    slug: string | null;
    hash: string | null;
  };
};

/** Preenche o que faltar com os padroes — leitura unica do formato do cardapio. */
export function resolveMenu(doc: Partial<MenuOnline> | null): ResolvedMenu {
  const store = doc?.store;
  const delivery = store?.delivery;
  return {
    slug: doc?.slug,
    slugChangedAt: doc?.slugChangedAt ?? null,
    enabled: doc?.enabled ?? false,
    categories: doc?.categories ?? [],
    items: doc?.items ?? [],
    optionGroups: doc?.optionGroups ?? [],
    store: {
      acceptedPayments: store?.acceptedPayments ?? [],
      delivery: {
        deliveryProvider:
          delivery?.deliveryProvider === DeliveryProvider.UBER
            ? DeliveryProvider.UBER
            : DeliveryProvider.PROPRIA,
        deliveryFee: delivery?.deliveryFee ?? 0,
        deliveryEnabled: delivery?.deliveryEnabled !== false,
        pickupEnabled: delivery?.pickupEnabled !== false,
      },
      contact: {
        address: store?.contact?.address ?? '',
        whatsapp: store?.contact?.whatsapp ?? '',
      },
      socialMedia: { instagram: store?.socialMedia?.instagram ?? '' },
      images: {
        coverUrl: store?.images?.coverUrl || null,
        logoUrl: store?.images?.logoUrl || null,
      },
      colors: { themeColor: store?.colors?.themeColor ?? '' },
      openingHours: store?.openingHours ?? {},
    },
    labelText: {
      description: doc?.labelText?.description ?? '',
      highlightLabel: doc?.labelText?.highlightLabel ?? '',
      highlightTitle: doc?.labelText?.highlightTitle ?? '',
    },
    publication: {
      version: doc?.publication?.version ?? 0,
      lastPublishedAt: doc?.publication?.lastPublishedAt ?? null,
      slug: doc?.publication?.slug ?? null,
      hash: doc?.publication?.hash ?? null,
    },
  };
}

/** Campos do DTO que sao gravados inteiros (nao viram caminhos com ponto). */
const LEAF_PATHS = new Set(['store.openingHours', 'store.acceptedPayments']);

/** `{ store: { delivery: { deliveryFee: 5 } } }` -> `{ 'store.delivery.deliveryFee': 5 }`. */
function toSetPaths(
  value: Record<string, unknown>,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !LEAF_PATHS.has(path)
    ) {
      toSetPaths(v as Record<string, unknown>, path, out);
    } else {
      out[path] = v;
    }
  }
  return out;
}

@Injectable()
export class MenuService {
  private readonly logger = new Logger(MenuService.name);

  constructor(
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
    @InjectModel(MenuOnline.name)
    private readonly menuModel: Model<MenuOnlineDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
    private readonly storageService: StorageService,
  ) {}

  /** Negocio + cardapio dele (com padroes, mesmo que o documento ainda nao exista). */
  private async load(businessId: string) {
    const id = new Types.ObjectId(businessId);
    const [business, doc] = await Promise.all([
      this.businessModel
        .findById(id)
        .select('name logoUrl timezone')
        .lean()
        .exec(),
      this.menuModel.findOne({ businessId: id }).lean<MenuOnline>().exec(),
    ]);
    if (!business) throw new NotFoundException('Negócio não encontrado');
    return { business, menu: resolveMenu(doc) };
  }

  /** Grava no cardapio do negocio (cria o documento na primeira vez). */
  private async write(
    businessId: Types.ObjectId,
    set: Record<string, unknown>,
  ) {
    try {
      await this.menuModel
        .updateOne({ businessId }, { $set: set }, { upsert: true })
        .exec();
    } catch (err) {
      // O indice unico decide quem fica com o slug, mesmo numa corrida.
      if (isDuplicateKey(err))
        throw new ConflictException('Este endereço de cardápio já está em uso');
      throw err;
    }
  }

  /**
   * Estoque dos produtos + dos componentes dos combos (que podem nem estar no
   * cardapio). E o que mede a disponibilidade de um combo.
   */
  private async stocksFor(
    businessId: Types.ObjectId,
    products: MenuSourceProduct[],
  ): Promise<StockIndex> {
    const stocks: StockIndex = new Map(
      products.map((p) => [String(p._id), p.stock ?? -1]),
    );
    const missing = comboComponentIds(products).filter((id) => !stocks.has(id));
    if (missing.length) {
      const components = await this.productModel
        .find({ businessId, _id: { $in: missing } })
        .select('stock')
        .lean<{ _id: unknown; stock?: number }[]>()
        .exec();
      for (const c of components) stocks.set(String(c._id), c.stock ?? -1);
    }
    return stocks;
  }

  /** Snapshot do que SERIA publicado agora (versao/data ainda nao definitivas). */
  private async buildFor(
    { business, menu }: Awaited<ReturnType<MenuService['load']>>,
    version: number,
    publishedAt: Date,
  ): Promise<MenuSnapshot> {
    const businessId = business._id;
    const activeIds = menu.items
      .filter((i) => i.active)
      .map((i) => i.productId);
    const [products, categories] = await Promise.all([
      this.productModel
        .find({ businessId, _id: { $in: activeIds }, isActive: true })
        .select(MENU_PRODUCT_FIELDS)
        .lean<MenuSourceProduct[]>()
        .exec(),
      this.categoryModel
        .find({ businessId, isActive: true })
        .select('name icon color')
        .lean<MenuSourceCategory[]>()
        .exec(),
    ]);
    const stocks = await this.stocksFor(businessId, products);
    const { store, labelText } = menu;

    return buildMenuSnapshot({
      store: {
        slug: menu.slug ?? '',
        name: business.name,
        description: labelText.description,
        logoUrl: store.images.logoUrl,
        coverUrl: store.images.coverUrl,
        address: store.contact.address,
        whatsapp: store.contact.whatsapp,
        timezone: resolveTimeZone(business.timezone),
        deliveryFee: store.delivery.deliveryFee,
        deliveryEnabled: store.delivery.deliveryEnabled,
        deliveryProvider: store.delivery.deliveryProvider,
        pickupEnabled: store.delivery.pickupEnabled,
        openingHours: store.openingHours,
        instagram: store.socialMedia.instagram,
        highlightLabel: labelText.highlightLabel.trim(),
        highlightTitle: labelText.highlightTitle.trim(),
        themeColor: /^#[0-9a-fA-F]{6}$/.test(store.colors.themeColor)
          ? store.colors.themeColor.toLowerCase()
          : null,
        acceptedPayments: store.acceptedPayments.length
          ? store.acceptedPayments
          : [...MENU_PAYMENT_METHODS],
      },
      categories,
      categoryOrder: menu.categories,
      products,
      items: menu.items,
      optionGroups: menu.optionGroups,
      stocks,
      version,
      publishedAt,
    });
  }

  async getSettings(businessId: string) {
    const loaded = await this.load(businessId);
    const { menu } = loaded;
    const preview = await this.buildFor(
      loaded,
      menu.publication.version,
      new Date(),
    );

    return {
      slug: menu.slug ?? '',
      enabled: menu.enabled,
      store: menu.store,
      labelText: menu.labelText,
      publication: {
        version: menu.publication.version,
        lastPublishedAt: menu.publication.lastPublishedAt,
      },
      publicUrl:
        menu.publication.lastPublishedAt && menu.slug
          ? this.storageService.publicUrl(menuFilePath(menu.slug))
          : null,
      hasUnpublishedChanges:
        !menu.publication.hash ||
        menu.publication.hash !== snapshotContentHash(preview),
      productCount: preview.categories.reduce(
        (n, c) => n + c.products.length,
        0,
      ),
    };
  }

  async updateSettings(businessId: string, dto: UpdateMenuSettingsDto) {
    const { business, menu } = await this.load(businessId);
    const bizId = business._id;

    // Sem entrega e sem retirada, o cliente nao teria como receber o pedido.
    const delivery =
      dto.store?.delivery?.deliveryEnabled ??
      menu.store.delivery.deliveryEnabled;
    const pickup =
      dto.store?.delivery?.pickupEnabled ?? menu.store.delivery.pickupEnabled;
    if (!delivery && !pickup) {
      throw new BadRequestException(
        'Ative a entrega, a retirada no local ou as duas',
      );
    }

    // Link no ar = ha um arquivo publicado. Trocar o slug entao derruba o
    // link antigo (e libera o endereco para outro negocio) — por isso o
    // intervalo minimo entre trocas.
    const linkIsLive = !!menu.publication.slug;
    let slugChanged = false;
    if (dto.slug !== undefined && dto.slug !== menu.slug) {
      if (RESERVED_SLUGS.has(dto.slug))
        throw new BadRequestException('Este endereço não está disponível');
      const taken = await this.menuModel
        .exists({ slug: dto.slug, businessId: { $ne: bizId } })
        .exec();
      if (taken)
        throw new ConflictException('Este endereço de cardápio já está em uso');
      if (linkIsLive && menu.slugChangedAt) {
        const nextAt =
          menu.slugChangedAt.getTime() +
          SLUG_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
        if (nextAt > Date.now())
          throw new BadRequestException(
            `O endereço só pode ser trocado a cada ${SLUG_CHANGE_COOLDOWN_DAYS} dias. Próxima troca: ${new Date(nextAt).toLocaleDateString('pt-BR')}`,
          );
      }
      slugChanged = true;
    }

    const set = toSetPaths(dto as Record<string, unknown>);
    if (slugChanged && linkIsLive) set.slugChangedAt = new Date();

    // Desligar o cardapio tira o arquivo do ar na hora — o link para de funcionar.
    const turnedOff = dto.enabled === false && !!menu.publication.slug;
    if (turnedOff) {
      await this.deleteMenuFile(bizId, menu.publication.slug!);
      Object.assign(set, {
        'publication.lastPublishedAt': null,
        'publication.hash': null,
        'publication.slug': null,
      });
    }

    if (Object.keys(set).length) await this.write(bizId, set);
    this.logger.log(
      `Cardápio configurado: negócio=${businessId} | campos=${Object.keys(set).join(',')}`,
    );

    // O endereco acabou de ser liberado por outro: o que sobrou do arquivo dele
    // nao pode ser servido sob o nosso slug. Se algum cardapio ainda o tem como
    // publicado (troca pendente), nao e resto: fica.
    if (slugChanged && dto.slug) {
      const stillPublished = await this.menuModel
        .exists({ 'publication.slug': dto.slug, businessId: { $ne: bizId } })
        .exec();
      if (!stillPublished)
        await this.storageService.deleteFileIfNotOwner(
          menuFilePath(dto.slug),
          bizId.toString(),
        );
    }

    // O arquivo mora em `menus/{slug}.json` e o JSON carrega o slug: republica
    // no endereco novo (o publish apaga o antigo, se ainda for nosso).
    if (slugChanged && linkIsLive && !turnedOff && menu.enabled) {
      try {
        await this.publish(businessId);
      } catch (err) {
        // O endereco antigo ja foi liberado: nao deixa o arquivo dele no ar.
        await this.deleteMenuFile(bizId, menu.publication.slug!);
        await this.write(bizId, {
          'publication.lastPublishedAt': null,
          'publication.hash': null,
          'publication.slug': null,
        });
        throw err;
      }
    }
    return this.getSettings(businessId);
  }

  /**
   * Tira `menus/{slug}.json` do ar so se for deste negocio: o slug antigo pode
   * ja ter sido assumido por outro, e o arquivo dele nao e nosso para apagar.
   */
  private deleteMenuFile(businessId: Types.ObjectId, slug: string) {
    return this.storageService.deleteFileIfOwner(
      menuFilePath(slug),
      businessId.toString(),
    );
  }

  async preview(businessId: string): Promise<MenuSnapshot> {
    const loaded = await this.load(businessId);
    return this.buildFor(
      loaded,
      loaded.menu.publication.version + 1,
      new Date(),
    );
  }

  async publish(businessId: string) {
    const loaded = await this.load(businessId);
    const { business, menu } = loaded;
    if (!menu.slug)
      throw new BadRequestException(
        'Defina o endereço (slug) do cardápio antes de publicar',
      );
    if (!menu.enabled)
      throw new BadRequestException('Ative o cardápio antes de publicar');

    const publishedAt = new Date();
    const version = menu.publication.version + 1;
    const snapshot = await this.buildFor(loaded, version, publishedAt);
    if (!snapshot.categories.length) {
      throw new BadRequestException(
        'Nenhum produto marcado para o cardápio (com Delivery próprio ativo)',
      );
    }

    const url = await this.storageService.uploadPublicJson(
      menuFilePath(menu.slug),
      snapshot,
      60,
      business._id.toString(),
    );
    if (menu.publication.slug && menu.publication.slug !== menu.slug) {
      await this.deleteMenuFile(business._id, menu.publication.slug);
    }

    await this.write(business._id, {
      'publication.version': version,
      'publication.lastPublishedAt': publishedAt,
      'publication.slug': menu.slug,
      'publication.hash': snapshotContentHash(snapshot),
    });

    this.logger.log(
      `Cardápio publicado: negócio=${businessId} | slug=${menu.slug} | versão=${version}`,
    );
    return { url, version, publishedAt };
  }

  /* ======================================================================
   * Categorias — ordem em que aparecem no cardapio
   * ==================================================================== */

  /** Categorias ativas na ordem do cardapio, com quantos produtos de cada uma vao ao ar. */
  async listCategories(businessId: string) {
    const { business, menu } = await this.load(businessId);
    const bizId = business._id;
    const activeIds = menu.items
      .filter((i) => i.active)
      .map((i) => i.productId);
    const [categories, products] = await Promise.all([
      this.categoryModel
        .find({ businessId: bizId, isActive: true })
        .select('name icon color')
        .lean<MenuSourceCategory[]>()
        .exec(),
      this.productModel
        .find({ businessId: bizId, _id: { $in: activeIds }, isActive: true })
        .select('categoryId prices.caixa prices.ordemBee')
        .lean<MenuSourceProduct[]>()
        .exec(),
    ]);
    const onMenu = new Map<string, number>();
    for (const p of products) {
      if (!menuPrice(p)) continue;
      const key = p.categoryId ? String(p.categoryId) : OTHER_CATEGORY_ID;
      onMenu.set(key, (onMenu.get(key) ?? 0) + 1);
    }
    const rank = categoryRank(menu.categories);
    return categories
      .map((c) => ({
        id: String(c._id),
        name: c.name,
        icon: c.icon ?? null,
        color: c.color ?? null,
        /** Produtos desta categoria marcados para o cardapio. */
        productCount: onMenu.get(String(c._id)) ?? 0,
        order: rank(String(c._id)),
      }))
      .sort(
        (a, b) => a.order - b.order || a.name.localeCompare(b.name, 'pt-BR'),
      )
      .map(({ order: _order, ...c }) => c);
  }

  /** Grava a ordem arrastada pelo operador (posicao na lista = ordem). */
  async reorderCategories(businessId: string, dto: ReorderMenuCategoriesDto) {
    const { business } = await this.load(businessId);
    const ids = [...new Set(dto.categoryIds)];
    const owned = await this.categoryModel
      .countDocuments({
        businessId: business._id,
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
      })
      .exec();
    if (owned !== ids.length)
      throw new BadRequestException('Lista com categoria inválida');

    await this.write(business._id, {
      categories: ids.map((id, order) => ({
        categoryId: new Types.ObjectId(id),
        order,
      })),
    });
    return { ok: true };
  }

  /* ======================================================================
   * Itens do cardapio — lista "O que vai ao ar"
   * ==================================================================== */

  /** Linha da lista: dados do produto + o que e do cardapio (exibir, complementos). */
  private toItemRow(
    p: MenuSourceProduct,
    item: MenuItem | undefined,
    categoryById: Map<string, MenuSourceCategory>,
    stocks?: StockIndex,
  ) {
    const price = menuPrice(p);
    const category = p.categoryId
      ? categoryById.get(String(p.categoryId))
      : undefined;
    return {
      productId: String(p._id),
      name: p.name,
      imageUrl: p.imageUrl || null,
      category: category
        ? {
            id: String(category._id),
            name: category.name,
            icon: category.icon ?? null,
          }
        : null,
      isCombo: !!p.isCombo,
      available: isProductAvailable(p, stocks),
      /** Preco cadastrado no produto (Delivery proprio, senao Caixa); null = sem preco. */
      price: price?.value ?? null,
      priceSource: price?.source ?? null,
      active: !!item?.active,
      optionGroupIds: (item?.optionGroupIds ?? []).map(String),
    };
  }

  /** Todos os produtos ativos do negocio, com o estado de cada um no cardapio. */
  async listItems(businessId: string) {
    const { business, menu } = await this.load(businessId);
    const bizId = business._id;
    const itemByProduct = indexMenuItems(menu.items) as Map<string, MenuItem>;
    const [products, categories] = await Promise.all([
      this.productModel
        .find({ businessId: bizId, isActive: true })
        .select(
          'name categoryId imageUrl stock isCombo comboItems.productId comboItems.quantity prices.caixa prices.ordemBee',
        )
        .lean<MenuSourceProduct[]>()
        .exec(),
      this.categoryModel
        .find({ businessId: bizId })
        .select('name icon color')
        .lean<MenuSourceCategory[]>()
        .exec(),
    ]);
    const categoryById = new Map(categories.map((c) => [String(c._id), c]));
    const stocks = await this.stocksFor(bizId, products);

    // Mesma ordem do cardapio: categorias na ordem definida, produtos por nome.
    const rank = categoryRank(menu.categories);
    const rankOf = (row: { category: { id: string } | null }) =>
      rank(row.category?.id ?? OTHER_CATEGORY_ID);
    return products
      .map((p) =>
        this.toItemRow(
          p,
          itemByProduct.get(String(p._id)),
          categoryById,
          stocks,
        ),
      )
      .sort(
        (a, b) =>
          rankOf(a) - rankOf(b) ||
          (a.category?.name ?? '').localeCompare(
            b.category?.name ?? '',
            'pt-BR',
          ) ||
          a.name.localeCompare(b.name, 'pt-BR'),
      );
  }

  /**
   * Edita uma linha: exibir e/ou complementos. O preco nao se edita aqui: e o
   * cadastrado no produto (ver menuPrice). Exibir exige produto com preco.
   */
  async updateItem(
    businessId: string,
    productId: string,
    dto: UpdateMenuItemDto,
  ) {
    const { business, menu } = await this.load(businessId);
    const bizId = business._id;
    const product = await this.productModel
      .findOne({
        _id: new Types.ObjectId(productId),
        businessId: bizId,
        isActive: true,
      })
      .exec();
    if (!product) throw new NotFoundException('Produto não encontrado');

    const items = [...menu.items];
    const index = items.findIndex((i) => String(i.productId) === productId);
    const current: MenuItem =
      index >= 0
        ? { ...items[index] }
        : { productId: product._id, active: false };

    if (dto.optionGroupIds !== undefined) {
      const known = new Set(menu.optionGroups.map((g) => String(g._id)));
      const ids = [...new Set(dto.optionGroupIds)];
      if (ids.some((id) => !known.has(id))) {
        throw new BadRequestException('Grupo de complementos inválido');
      }
      current.optionGroupIds = ids.map((id) => new Types.ObjectId(id));
    }
    if (dto.active !== undefined) current.active = dto.active;
    // Nao existe item no cardapio sem preco cadastrado no produto.
    if (dto.active && !menuPrice(product as MenuSourceProduct)) {
      throw new BadRequestException(
        'Produto sem preço cadastrado — defina o preço em Produtos',
      );
    }

    if (index >= 0) items[index] = current;
    else items.push(current);
    await this.write(bizId, { items });

    this.logger.log(
      `Item do cardápio: negócio=${businessId} | produto=${productId} | campos=${Object.keys(dto).join(',')}`,
    );
    const categories = product.categoryId
      ? await this.categoryModel
          .find({ _id: product.categoryId })
          .select('name icon color')
          .lean<MenuSourceCategory[]>()
          .exec()
      : [];
    const source = product.toObject() as MenuSourceProduct;
    return this.toItemRow(
      source,
      current,
      new Map(categories.map((c) => [String(c._id), c])),
      await this.stocksFor(bizId, [source]),
    );
  }

  /* ======================================================================
   * Complementos — grupos reutilizaveis entre os itens do cardapio
   * ==================================================================== */

  private toGroupRow(g: MenuOptionGroup, usedBy: number) {
    return {
      id: String(g._id),
      name: g.name,
      min: g.min ?? 0,
      max: g.max ?? 1,
      active: g.active !== false,
      options: (g.options ?? []).map((o) => ({
        id: String(o._id),
        name: o.name,
        price: o.price ?? 0,
        active: o.active !== false,
      })),
      /** Quantos itens do cardapio usam o grupo. */
      usedBy,
    };
  }

  private usageCount(items: MenuItem[] | undefined, groupId: string) {
    return (items ?? []).filter((i) =>
      (i.optionGroupIds ?? []).some((id) => String(id) === groupId),
    ).length;
  }

  async listOptionGroups(businessId: string) {
    const { menu } = await this.load(businessId);
    return menu.optionGroups.map((g) =>
      this.toGroupRow(g, this.usageCount(menu.items, String(g._id))),
    );
  }

  /** Cria (sem `groupId`) ou substitui um grupo inteiro, preservando ids de opcoes existentes. */
  async saveOptionGroup(
    businessId: string,
    groupId: string | null,
    dto: SaveOptionGroupDto,
  ) {
    if (dto.min > dto.max) {
      throw new BadRequestException('O mínimo não pode ser maior que o máximo');
    }
    const { business, menu } = await this.load(businessId);
    const groups = [...menu.optionGroups];
    const index = groupId
      ? groups.findIndex((g) => String(g._id) === groupId)
      : -1;
    if (groupId && index < 0)
      throw new NotFoundException('Grupo de complementos não encontrado');

    const previous = index >= 0 ? groups[index] : undefined;
    const previousIds = new Set(
      (previous?.options ?? []).map((o) => String(o._id)),
    );
    const group: MenuOptionGroup = {
      _id: previous?._id ?? new Types.ObjectId(),
      name: dto.name.trim(),
      min: dto.min,
      max: dto.max,
      active: dto.active ?? previous?.active ?? true,
      options: dto.options.map((o) => ({
        // So reaproveita id que ja era deste grupo (nao deixa "roubar" id de outro).
        _id:
          o.id && previousIds.has(o.id)
            ? new Types.ObjectId(o.id)
            : new Types.ObjectId(),
        name: o.name.trim(),
        price: Math.round(o.price * 100) / 100,
        active: o.active ?? true,
      })),
    };
    if (index >= 0) groups[index] = group;
    else groups.push(group);

    await this.write(business._id, { optionGroups: groups });
    this.logger.log(
      `Complementos salvos: negócio=${businessId} | grupo=${String(group._id)}`,
    );
    return this.toGroupRow(
      group,
      this.usageCount(menu.items, String(group._id)),
    );
  }

  /** Remove o grupo e tira ele de todos os itens que o usavam. */
  async removeOptionGroup(businessId: string, groupId: string) {
    const { business, menu } = await this.load(businessId);
    if (!menu.optionGroups.some((g) => String(g._id) === groupId)) {
      throw new NotFoundException('Grupo de complementos não encontrado');
    }
    const items = menu.items.map((i) => ({
      ...i,
      optionGroupIds: (i.optionGroupIds ?? []).filter(
        (id) => String(id) !== groupId,
      ),
    }));
    await this.write(business._id, {
      optionGroups: menu.optionGroups.filter((g) => String(g._id) !== groupId),
      items,
    });
    return { ok: true };
  }

  /* ======================================================================
   * Logo e capa do cardapio
   * ==================================================================== */

  private static readonly IMAGE_PATH = {
    logo: 'store.images.logoUrl',
    cover: 'store.images.coverUrl',
  } as const;

  /**
   * Troca a logo ou a capa do cardapio (store.images). Sao do cardapio — o
   * logo do negocio no sistema nao muda. Apaga a imagem anterior se era nossa.
   */
  async setStoreImage(
    businessId: string,
    kind: 'logo' | 'cover',
    file: Express.Multer.File,
  ) {
    const { business, menu } = await this.load(businessId);
    const previous =
      kind === 'logo' ? menu.store.images.logoUrl : menu.store.images.coverUrl;
    const { url } = await this.storageService.uploadStoreImage(
      businessId,
      kind,
      file,
    );
    await this.write(business._id, {
      [MenuService.IMAGE_PATH[kind]]: url,
    });
    await this.deleteOwnImage(previous, business.logoUrl);
    this.logger.log(
      `Imagem do cardápio (${kind}) atualizada: negócio=${businessId}`,
    );
    return this.getSettings(businessId);
  }

  async removeStoreImage(businessId: string, kind: 'logo' | 'cover') {
    const { business, menu } = await this.load(businessId);
    const previous =
      kind === 'logo' ? menu.store.images.logoUrl : menu.store.images.coverUrl;
    await this.menuModel
      .updateOne(
        { businessId: business._id },
        { $unset: { [MenuService.IMAGE_PATH[kind]]: '' } },
      )
      .exec();
    await this.deleteOwnImage(previous, business.logoUrl);
    return this.getSettings(businessId);
  }

  /**
   * Apaga do Storage so imagens nossas (URL colada de fora fica intacta) e
   * nunca a que ainda e o logo do negocio (o cardapio pode ter herdado ela).
   */
  private async deleteOwnImage(
    url: string | null | undefined,
    businessLogoUrl?: string,
  ) {
    if (!url || url === businessLogoUrl) return;
    const path = this.storageService.pathFromPublicUrl(url);
    if (!path) return;
    try {
      await this.storageService.deleteFile(path);
    } catch (err) {
      // Imagem antiga que nao apagou nao pode derrubar a troca.
      this.logger.warn(
        `Não consegui apagar ${path}: ${(err as Error).message}`,
      );
    }
  }
}
