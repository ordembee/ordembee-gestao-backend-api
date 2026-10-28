import { createHash } from 'crypto';
import type { MenuOpeningHours } from './schemas/menu-online.schema';

/**
 * Formato do JSON publicado em `menus/{slug}.json` e lido pelo cardapio e pelo
 * ordembee-cardapio-web-backend-api. E um contrato publico: nunca coloque custo, estoque
 * numerico, precificacao ou qualquer dado interno aqui.
 */
export interface MenuSnapshotOption {
  id: string;
  name: string;
  price: number;
}

/** Grupo de complementos: o cliente marca entre `min` e `max` opcoes (min > 0 = obrigatorio). */
export interface MenuSnapshotOptionGroup {
  id: string;
  name: string;
  min: number;
  max: number;
  options: MenuSnapshotOption[];
}

export interface MenuSnapshotProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  imageUrl: string | null;
  available: boolean;
  optionGroups: MenuSnapshotOptionGroup[];
}

export interface MenuSnapshotCategory {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  products: MenuSnapshotProduct[];
}

export interface MenuSnapshotStore {
  slug: string;
  name: string;
  description: string;
  logoUrl: string | null;
  coverUrl: string | null;
  address: string;
  whatsapp: string;
  timezone: string;
  deliveryFee: number;
  /** false = a loja nao entrega (so retirada). */
  deliveryEnabled: boolean;
  /**
   * Quem entrega: 'PROPRIA' (taxa fixa `deliveryFee`) ou 'UBER' (frete
   * cotado no checkout e pago antes por Pix).
   */
  deliveryProvider: 'PROPRIA' | 'UBER';
  pickupEnabled: boolean;
  openingHours: MenuOpeningHours;
  instagram: string;
  /** Frase de destaque do negocio (linha pequena + titulo); '' = nao aparece. */
  highlightLabel: string;
  highlightTitle: string;
  /** Cor da marca (#RRGGBB) para o cardapio aplicar; null = cor padrao. */
  themeColor: string | null;
  /** PaymentMethod aceitos no cardapio (CARTAO_CREDITO, CARTAO_DEBITO, PIX, DINHEIRO). */
  acceptedPayments: string[];
}

export interface MenuSnapshot {
  version: number;
  publishedAt: string;
  store: MenuSnapshotStore;
  categories: MenuSnapshotCategory[];
}

/** Campos do Product que o snapshot le — nada alem disso sai do banco. */
export interface MenuSourceProduct {
  _id: unknown;
  name: string;
  description?: string;
  categoryId?: unknown;
  imageUrl?: string;
  stock?: number;
  isActive?: boolean;
  isCombo?: boolean;
  /** Componentes do combo — a disponibilidade do combo vem deles. */
  comboItems?: { productId: unknown; quantity: number }[];
  prices?: {
    caixa?: { value?: number; active?: boolean };
    ordemBee?: { value?: number; active?: boolean };
  };
}

/** Item do cardapio (MenuOnline.items) — exibir e complementos sao do cardapio, nao do produto. */
export interface MenuSourceItem {
  productId: unknown;
  active?: boolean;
  optionGroupIds?: unknown[];
}

/** Posicao de uma categoria no cardapio (MenuOnline.categories). */
export interface MenuSourceCategoryOrder {
  categoryId: unknown;
  order?: number;
}

/** Grupo de complementos como gravado em MenuOnline.optionGroups. */
export interface MenuSourceOptionGroup {
  _id?: unknown;
  name: string;
  min?: number;
  max?: number;
  active?: boolean;
  options?: { _id?: unknown; name: string; price?: number; active?: boolean }[];
}

/**
 * Grupos efetivos de um item: so os ativos, com opcoes ativas, na ordem do
 * item. Normaliza min/max para o que da para cumprir. Regra unica: usada no
 * snapshot E na validacao do pedido.
 */
export function resolveOptionGroups(
  item: MenuSourceItem | undefined,
  groups: MenuSourceOptionGroup[] | undefined,
): MenuSnapshotOptionGroup[] {
  const byId = new Map((groups ?? []).map((g) => [String(g._id), g]));
  const result: MenuSnapshotOptionGroup[] = [];
  for (const id of item?.optionGroupIds ?? []) {
    const group = byId.get(String(id));
    if (!group || group.active === false) continue;
    const options = (group.options ?? [])
      .filter((o) => o.active !== false)
      .map((o) => ({
        id: String(o._id),
        name: o.name,
        price: Math.round((o.price ?? 0) * 100) / 100,
      }));
    if (!options.length) continue;
    const max = Math.min(Math.max(group.max ?? 1, 1), options.length);
    const min = Math.min(Math.max(group.min ?? 0, 0), max);
    result.push({ id: String(group._id), name: group.name, min, max, options });
  }
  return result;
}

export interface MenuSourceCategory {
  _id: unknown;
  name: string;
  icon?: string;
  color?: string;
}

/** Projecao usada nas consultas do snapshot e da rota interna de pedidos. */
export const MENU_PRODUCT_FIELDS =
  'name description categoryId imageUrl stock isActive isCombo comboItems.productId comboItems.quantity prices.caixa prices.ordemBee';

/** productId -> item do cardapio. */
export function indexMenuItems(
  items: MenuSourceItem[] | undefined,
): Map<string, MenuSourceItem> {
  return new Map((items ?? []).map((i) => [String(i.productId), i]));
}

/** Categoria de quem nao tem categoria (ou tem uma inativa). */
export const OTHER_CATEGORY_ID = 'outros';

export type MenuPriceSource = 'ordembee' | 'caixa';

/**
 * Preco do cardapio = o que ja esta cadastrado no produto: canal OrdemBee
 * quando ativo e com valor; senao o preco de Caixa. O cardapio nao
 * tem preco proprio — para mudar, edita-se o produto.
 */
export function menuPrice(
  p: MenuSourceProduct,
): { value: number; source: MenuPriceSource } | null {
  const round = (v: number) => Math.round(v * 100) / 100;
  const ordemBee = p.prices?.ordemBee;
  if (ordemBee?.active && (ordemBee.value ?? 0) > 0) {
    return { value: round(ordemBee.value!), source: 'ordembee' };
  }
  const caixa = p.prices?.caixa?.value ?? 0;
  return caixa > 0 ? { value: round(caixa), source: 'caixa' } : null;
}

/** Regra unica de "esta no cardapio": usada no snapshot E ao aceitar pedidos. */
export function isProductOnMenu(
  p: MenuSourceProduct,
  item: MenuSourceItem | undefined,
): boolean {
  return !!(item?.active && p.isActive !== false && menuPrice(p));
}

/** productId -> estoque (inclui componentes de combos). */
export type StockIndex = Map<string, number>;

/** Abaixo disto (e acima de zero) o cardapio mostra "Ultimas unidades". */
export const LOW_STOCK_THRESHOLD = 3;

/** O que o cliente ve: nunca o numero do estoque, so o nivel. */
export type MenuAvailability = 'ok' | 'low' | 'out';

/** Ids dos componentes de combos — precisam ser carregados para medir o combo. */
export function comboComponentIds(products: MenuSourceProduct[]): string[] {
  const ids = new Set<string>();
  for (const p of products) {
    if (p.isCombo)
      for (const c of p.comboItems ?? []) ids.add(String(c.productId));
  }
  return [...ids];
}

/**
 * Unidades que da para vender agora; null = sem limite (sem controle de
 * estoque). Estoque -1 = sem controle; outros negativos = vendeu alem: zero.
 * Combo = o menor numero de combos que os componentes controlados permitem
 * (componente sem controle, ou que nao veio em `stocks`, nao limita).
 */
export function availableUnits(
  p: MenuSourceProduct,
  stocks?: StockIndex,
): number | null {
  if (p.isCombo) {
    let units: number | null = null;
    for (const c of p.comboItems ?? []) {
      const stock = stocks?.get(String(c.productId));
      if (stock === undefined || stock === -1) continue;
      const fits = Math.floor(Math.max(0, stock) / Math.max(1, c.quantity));
      units = units === null ? fits : Math.min(units, fits);
    }
    return units;
  }
  const stock = p.stock ?? -1;
  return stock === -1 ? null : Math.max(0, stock);
}

export function availabilityLevel(
  p: MenuSourceProduct,
  stocks?: StockIndex,
): MenuAvailability {
  const units = availableUnits(p, stocks);
  if (units === null) return 'ok';
  if (units <= 0) return 'out';
  return units <= LOW_STOCK_THRESHOLD ? 'low' : 'ok';
}

/** Esgotado = nao da para vender nem uma unidade agora. */
export function isProductAvailable(
  p: MenuSourceProduct,
  stocks?: StockIndex,
): boolean {
  return availabilityLevel(p, stocks) !== 'out';
}

const byOrderThenName = (
  a: { order: number; name: string },
  b: { order: number; name: string },
) => a.order - b.order || a.name.localeCompare(b.name, 'pt-BR');

/**
 * categoryId -> posicao no cardapio. Categoria sem posicao vai depois das
 * ordenadas (por nome); "Outros" sempre por ultimo.
 */
export function categoryRank(
  order: MenuSourceCategoryOrder[] | undefined,
): (categoryId: string) => number {
  const byId = new Map(
    (order ?? []).map((c) => [String(c.categoryId), c.order ?? 0]),
  );
  return (id) =>
    id === OTHER_CATEGORY_ID
      ? Number.POSITIVE_INFINITY
      : (byId.get(id) ?? Number.MAX_SAFE_INTEGER);
}

export function buildMenuSnapshot(input: {
  store: MenuSnapshotStore;
  categories: MenuSourceCategory[];
  /** Ordem das categorias definida no cardapio. */
  categoryOrder?: MenuSourceCategoryOrder[];
  products: MenuSourceProduct[];
  items: MenuSourceItem[];
  optionGroups?: MenuSourceOptionGroup[];
  /** Estoque dos componentes de combos (ver `comboComponentIds`). */
  stocks?: StockIndex;
  version: number;
  publishedAt: Date;
}): MenuSnapshot {
  const itemByProduct = indexMenuItems(input.items);
  const categoryById = new Map(input.categories.map((c) => [String(c._id), c]));
  const rank = categoryRank(input.categoryOrder);
  const groups = new Map<string, MenuSnapshotCategory>();

  for (const p of input.products) {
    const item = itemByProduct.get(String(p._id));
    if (!isProductOnMenu(p, item)) continue;
    const source = p.categoryId
      ? categoryById.get(String(p.categoryId))
      : undefined;
    const key = source ? String(source._id) : OTHER_CATEGORY_ID;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        name: source?.name ?? 'Outros',
        icon: source?.icon ?? null,
        color: source?.color ?? null,
        products: [],
      };
      groups.set(key, group);
    }
    group.products.push({
      id: String(p._id),
      name: p.name,
      description: p.description ?? '',
      price: menuPrice(p)!.value,
      imageUrl: p.imageUrl || null,
      available: isProductAvailable(p, input.stocks),
      optionGroups: resolveOptionGroups(item, input.optionGroups),
    });
  }

  // Categorias na ordem do cardapio; produtos de cada uma por nome.
  const categories = Array.from(groups.values())
    .map((c) => ({ ...c, order: rank(c.id) }))
    .sort(byOrderThenName)
    .map(({ order: _order, ...c }) => ({
      ...c,
      products: c.products.sort((a, b) =>
        a.name.localeCompare(b.name, 'pt-BR'),
      ),
    }));

  return {
    version: input.version,
    publishedAt: input.publishedAt.toISOString(),
    store: input.store,
    categories,
  };
}

/** Hash do conteudo (sem versao/data) — detecta "alteracoes nao publicadas". */
export function snapshotContentHash(
  snapshot: Pick<MenuSnapshot, 'store' | 'categories'>,
): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        store: snapshot.store,
        categories: snapshot.categories,
      }),
    )
    .digest('hex');
}
