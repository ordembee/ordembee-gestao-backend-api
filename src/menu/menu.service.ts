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
  MenuItem,
  MenuOptionGroup,
  MenuSettings,
} from '../business/schemas/business.schema';
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
import { ReorderMenuItemsDto, UpdateMenuItemDto } from './dto/menu-items.dto';
import {
  MENU_PRODUCT_FIELDS,
  MenuSnapshot,
  MenuSourceCategory,
  MenuSourceProduct,
  StockIndex,
  buildLiveProducts,
  buildMenuSnapshot,
  comboComponentIds,
  indexMenuItems,
  isProductAvailable,
  menuPrice,
  snapshotContentHash,
} from './menu-snapshot';

export const menuFilePath = (slug: string) => `menus/${slug}.json`;

const DEFAULT_MENU: MenuSettings = {
  enabled: false,
  items: [],
  deliveryFee: 0,
  deliveryEnabled: true,
  pickupEnabled: true,
  openingHours: {},
  publishedVersion: 0,
};

@Injectable()
export class MenuService {
  private readonly logger = new Logger(MenuService.name);

  constructor(
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
    private readonly storageService: StorageService,
  ) {}

  private async requireBusiness(businessId: string) {
    const business = await this.businessModel
      .findById(new Types.ObjectId(businessId))
      .select('name logoUrl timezone menu')
      .lean()
      .exec();
    if (!business) throw new NotFoundException('Negócio não encontrado');
    return business;
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
    business: Awaited<ReturnType<MenuService['requireBusiness']>>,
    version: number,
    publishedAt: Date,
  ): Promise<MenuSnapshot> {
    const businessId = business._id as Types.ObjectId;
    const menu = { ...DEFAULT_MENU, ...(business.menu ?? {}) };
    const items = menu.items ?? [];
    const activeIds = items.filter((i) => i.active).map((i) => i.productId);
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

    return buildMenuSnapshot({
      store: {
        slug: menu.slug ?? '',
        name: business.name,
        description: menu.description ?? '',
        logoUrl: business.logoUrl || null,
        coverUrl: menu.coverUrl || null,
        address: menu.address ?? '',
        whatsapp: menu.whatsapp ?? '',
        timezone: resolveTimeZone(business.timezone),
        deliveryFee: menu.deliveryFee ?? 0,
        deliveryEnabled: menu.deliveryEnabled !== false,
        pickupEnabled: menu.pickupEnabled ?? true,
        openingHours: menu.openingHours ?? {},
        instagram: menu.instagram ?? '',
        themeColor: /^#[0-9a-fA-F]{6}$/.test(menu.themeColor ?? '')
          ? menu.themeColor!.toLowerCase()
          : null,
        acceptedPayments: menu.acceptedPayments?.length
          ? menu.acceptedPayments
          : [...MENU_PAYMENT_METHODS],
      },
      categories,
      products,
      items,
      optionGroups: menu.optionGroups ?? [],
      stocks,
      version,
      publishedAt,
    });
  }

  /**
   * Canal "ao vivo" (rota interna, servido ao publico pelo my-store-cardapio-web-back-api):
   * disponibilidade, descricao e foto dos produtos que estao no cardapio agora.
   * Vai ao ar sem "Publicar"; preco e nome nao entram (so publicando).
   */
  async liveFor(slug: string) {
    const business = await this.businessModel
      .findOne({ 'menu.slug': slug })
      .select('menu.enabled menu.items')
      .lean()
      .exec();
    if (!business?.menu?.enabled) {
      throw new NotFoundException('Cardápio não encontrado');
    }
    const businessId = business._id as Types.ObjectId;
    const items = business.menu.items ?? [];
    const products = await this.productModel
      .find({
        businessId,
        _id: { $in: items.filter((i) => i.active).map((i) => i.productId) },
        isActive: true,
      })
      .select(MENU_PRODUCT_FIELDS)
      .lean<MenuSourceProduct[]>()
      .exec();
    const stocks = await this.stocksFor(businessId, products);
    return {
      generatedAt: new Date().toISOString(),
      products: buildLiveProducts({ products, items, stocks }),
    };
  }

  async getSettings(businessId: string) {
    const business = await this.requireBusiness(businessId);
    const menu = { ...DEFAULT_MENU, ...(business.menu ?? {}) };
    const preview = await this.buildFor(
      business,
      menu.publishedVersion,
      new Date(),
    );
    const {
      publishedHash: _hash,
      publishedSlug: _slug,
      items: _items,
      optionGroups: _groups,
      ...settings
    } = menu;

    return {
      ...settings,
      logoUrl: business.logoUrl || null,
      publicUrl:
        menu.lastPublishedAt && menu.slug
          ? this.storageService.publicUrl(menuFilePath(menu.slug))
          : null,
      hasUnpublishedChanges:
        !menu.publishedHash ||
        menu.publishedHash !== snapshotContentHash(preview),
      productCount: preview.categories.reduce(
        (n, c) => n + c.products.length,
        0,
      ),
    };
  }

  async updateSettings(businessId: string, dto: UpdateMenuSettingsDto) {
    const business = await this.requireBusiness(businessId);
    const current = { ...DEFAULT_MENU, ...(business.menu ?? {}) };

    // Sem entrega e sem retirada, o cliente nao teria como receber o pedido.
    const delivery = dto.deliveryEnabled ?? current.deliveryEnabled !== false;
    const pickup = dto.pickupEnabled ?? current.pickupEnabled !== false;
    if (!delivery && !pickup) {
      throw new BadRequestException(
        'Ative a entrega, a retirada no local ou as duas',
      );
    }

    if (dto.slug !== undefined && dto.slug !== current.slug) {
      const taken = await this.businessModel
        .exists({ 'menu.slug': dto.slug, _id: { $ne: business._id } })
        .exec();
      if (taken)
        throw new ConflictException('Este endereço de cardápio já está em uso');
    }

    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`menu.${key}`] = value;
    }

    // Desligar o cardapio tira o arquivo do ar na hora — o link para de funcionar.
    if (dto.enabled === false && current.publishedSlug) {
      await this.storageService.deleteFile(menuFilePath(current.publishedSlug));
      Object.assign(set, {
        'menu.lastPublishedAt': null,
        'menu.publishedHash': null,
        'menu.publishedSlug': null,
      });
    }

    if (Object.keys(set).length) {
      await this.businessModel
        .updateOne({ _id: business._id }, { $set: set })
        .exec();
    }
    this.logger.log(
      `Cardápio configurado: negócio=${businessId} | campos=${Object.keys(dto).join(',')}`,
    );
    return this.getSettings(businessId);
  }

  async preview(businessId: string): Promise<MenuSnapshot> {
    const business = await this.requireBusiness(businessId);
    return this.buildFor(
      business,
      (business.menu?.publishedVersion ?? 0) + 1,
      new Date(),
    );
  }

  async publish(businessId: string) {
    const business = await this.requireBusiness(businessId);
    const menu = { ...DEFAULT_MENU, ...(business.menu ?? {}) };
    if (!menu.slug)
      throw new BadRequestException(
        'Defina o endereço (slug) do cardápio antes de publicar',
      );
    if (!menu.enabled)
      throw new BadRequestException('Ative o cardápio antes de publicar');

    const publishedAt = new Date();
    const version = (menu.publishedVersion ?? 0) + 1;
    const snapshot = await this.buildFor(business, version, publishedAt);
    if (!snapshot.categories.length) {
      throw new BadRequestException(
        'Nenhum produto marcado para o cardápio (com Delivery próprio ativo)',
      );
    }

    const url = await this.storageService.uploadPublicJson(
      menuFilePath(menu.slug),
      snapshot,
    );
    if (menu.publishedSlug && menu.publishedSlug !== menu.slug) {
      await this.storageService.deleteFile(menuFilePath(menu.publishedSlug));
    }

    await this.businessModel
      .updateOne(
        { _id: business._id },
        {
          $set: {
            'menu.publishedVersion': version,
            'menu.lastPublishedAt': publishedAt,
            'menu.publishedSlug': menu.slug,
            'menu.publishedHash': snapshotContentHash(snapshot),
          },
        },
      )
      .exec();

    this.logger.log(
      `Cardápio publicado: negócio=${businessId} | slug=${menu.slug} | versão=${version}`,
    );
    return { url, version, publishedAt };
  }

  /* ======================================================================
   * Itens do cardapio — lista "O que vai ao ar"
   * ==================================================================== */

  /** Linha da lista: dados do produto + o que e do cardapio (exibir, selo, ordem). */
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
      tag: item?.tag ?? '',
      optionGroupIds: (item?.optionGroupIds ?? []).map(String),
      order: item?.order ?? null,
    };
  }

  /** Todos os produtos ativos do negocio, com o estado de cada um no cardapio. */
  async listItems(businessId: string) {
    const business = await this.requireBusiness(businessId);
    const itemByProduct = indexMenuItems(business.menu?.items) as Map<
      string,
      MenuItem
    >;
    const [products, categories] = await Promise.all([
      this.productModel
        .find({ businessId: business._id, isActive: true })
        .select(
          'name categoryId imageUrl stock isCombo comboItems.productId comboItems.quantity prices.caixa prices.deliveryProprio',
        )
        .lean<MenuSourceProduct[]>()
        .exec(),
      this.categoryModel
        .find({ businessId: business._id })
        .select('name icon color')
        .lean<MenuSourceCategory[]>()
        .exec(),
    ]);
    const categoryById = new Map(categories.map((c) => [String(c._id), c]));
    const stocks = await this.stocksFor(business._id as Types.ObjectId, products);

    // Quem ja tem ordem no cardapio vem primeiro, na ordem definida; o resto por nome.
    const rank = (order: number | null) =>
      order === null ? Number.MAX_SAFE_INTEGER : order;
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
          rank(a.order) - rank(b.order) ||
          a.name.localeCompare(b.name, 'pt-BR'),
      );
  }

  /**
   * Edita uma linha: exibir e/ou selo. O preco nao se edita aqui: e o
   * cadastrado no produto (ver menuPrice). Exibir exige produto com preco.
   */
  async updateItem(
    businessId: string,
    productId: string,
    dto: UpdateMenuItemDto,
  ) {
    const business = await this.requireBusiness(businessId);
    const product = await this.productModel
      .findOne({
        _id: new Types.ObjectId(productId),
        businessId: business._id,
        isActive: true,
      })
      .exec();
    if (!product) throw new NotFoundException('Produto não encontrado');

    const items = [...(business.menu?.items ?? [])];
    const index = items.findIndex((i) => String(i.productId) === productId);
    const current: MenuItem =
      index >= 0
        ? { ...items[index] }
        : {
            productId: product._id as Types.ObjectId,
            active: false,
            order:
              items.reduce((max, i) => Math.max(max, i.order ?? 0), -1) + 1,
          };

    if (dto.tag !== undefined) current.tag = dto.tag.trim() || undefined;
    if (dto.optionGroupIds !== undefined) {
      const known = new Set(
        (business.menu?.optionGroups ?? []).map((g) => String(g._id)),
      );
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
    await this.businessModel
      .updateOne({ _id: business._id }, { $set: { 'menu.items': items } })
      .exec();

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
      await this.stocksFor(business._id as Types.ObjectId, [source]),
    );
  }

  /** Grava a ordem arrastada pelo operador (posicao na lista = ordem). */
  async reorderItems(businessId: string, dto: ReorderMenuItemsDto) {
    const business = await this.requireBusiness(businessId);
    const ids = [...new Set(dto.productIds)];
    const owned = await this.productModel
      .countDocuments({
        businessId: business._id,
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
      })
      .exec();
    if (owned !== ids.length)
      throw new BadRequestException('Lista com produto inválido');

    const byProduct = indexMenuItems(business.menu?.items) as Map<
      string,
      MenuItem
    >;
    const reordered: MenuItem[] = ids.map((id, order) => ({
      ...(byProduct.get(id) ?? {
        productId: new Types.ObjectId(id),
        active: false,
      }),
      order,
    }));
    // Itens fora da lista enviada (ex.: produto desativado) mantem o estado e vao para o fim.
    const rest = (business.menu?.items ?? [])
      .filter((i) => !ids.includes(String(i.productId)))
      .map((i, n) => ({ ...i, order: ids.length + n }));

    await this.businessModel
      .updateOne(
        { _id: business._id },
        { $set: { 'menu.items': [...reordered, ...rest] } },
      )
      .exec();
    return { ok: true };
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
    const business = await this.requireBusiness(businessId);
    const items = business.menu?.items;
    return (business.menu?.optionGroups ?? []).map((g) =>
      this.toGroupRow(g, this.usageCount(items, String(g._id))),
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
    const business = await this.requireBusiness(businessId);
    const groups = [...(business.menu?.optionGroups ?? [])];
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

    await this.businessModel
      .updateOne(
        { _id: business._id },
        { $set: { 'menu.optionGroups': groups } },
      )
      .exec();
    this.logger.log(
      `Complementos salvos: negócio=${businessId} | grupo=${String(group._id)}`,
    );
    return this.toGroupRow(
      group,
      this.usageCount(business.menu?.items, String(group._id)),
    );
  }

  /** Remove o grupo e tira ele de todos os itens que o usavam. */
  async removeOptionGroup(businessId: string, groupId: string) {
    const business = await this.requireBusiness(businessId);
    const groups = business.menu?.optionGroups ?? [];
    if (!groups.some((g) => String(g._id) === groupId)) {
      throw new NotFoundException('Grupo de complementos não encontrado');
    }
    const items = (business.menu?.items ?? []).map((i) => ({
      ...i,
      optionGroupIds: (i.optionGroupIds ?? []).filter(
        (id) => String(id) !== groupId,
      ),
    }));
    await this.businessModel
      .updateOne(
        { _id: business._id },
        {
          $set: {
            'menu.optionGroups': groups.filter(
              (g) => String(g._id) !== groupId,
            ),
            'menu.items': items,
          },
        },
      )
      .exec();
    return { ok: true };
  }

  /* ======================================================================
   * Logo e capa da loja
   * ==================================================================== */

  /**
   * Troca a logo (Business.logoUrl — a mesma do resto do sistema) ou a capa
   * do cardapio (menu.coverUrl). Apaga a imagem anterior se era nossa.
   */
  async setStoreImage(
    businessId: string,
    kind: 'logo' | 'cover',
    file: Express.Multer.File,
  ) {
    const business = await this.requireBusiness(businessId);
    const previous =
      kind === 'logo' ? business.logoUrl : business.menu?.coverUrl;
    const { url } = await this.storageService.uploadStoreImage(
      businessId,
      kind,
      file,
    );
    await this.businessModel
      .updateOne(
        { _id: business._id },
        { $set: kind === 'logo' ? { logoUrl: url } : { 'menu.coverUrl': url } },
      )
      .exec();
    await this.deleteOwnImage(previous);
    this.logger.log(
      `Imagem da loja (${kind}) atualizada: negócio=${businessId}`,
    );
    return this.getSettings(businessId);
  }

  async removeStoreImage(businessId: string, kind: 'logo' | 'cover') {
    const business = await this.requireBusiness(businessId);
    const previous =
      kind === 'logo' ? business.logoUrl : business.menu?.coverUrl;
    await this.businessModel
      .updateOne(
        { _id: business._id },
        { $unset: kind === 'logo' ? { logoUrl: '' } : { 'menu.coverUrl': '' } },
      )
      .exec();
    await this.deleteOwnImage(previous);
    return this.getSettings(businessId);
  }

  /** Apaga do Storage so imagens nossas (URL colada de fora fica intacta). */
  private async deleteOwnImage(url: string | undefined) {
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
