import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BusinessDocument = Business & Document;

export interface GerentePermissions {
  canViewSales: boolean;
  canCancelSales: boolean;
  canApplyDiscounts: boolean;
  canEditProducts: boolean;
  canChangePrices: boolean;
  canManageStock: boolean;
  canViewFinancialReports: boolean;
  canManageUsers: boolean;
}

export interface CaixaPermissions {
  canViewProducts: boolean;
  canViewCategories: boolean;
  canApplyDiscounts: boolean;
  canCancelSales: boolean;
  canRefund: boolean;
  canSellWithNegativeStock: boolean;
  canViewStock: boolean;
}

export interface BusinessPermissions {
  gerente: GerentePermissions;
  caixa: CaixaPermissions;
}

export type EffectivePermissions = GerentePermissions & CaixaPermissions;

export const DEFAULT_PERMISSIONS: BusinessPermissions = {
  gerente: {
    canViewSales: true,
    canCancelSales: false,
    canApplyDiscounts: true,
    canEditProducts: true,
    canChangePrices: false,
    canManageStock: true,
    canViewFinancialReports: false,
    canManageUsers: false,
  },
  caixa: {
    canViewProducts: true,
    canViewCategories: true,
    canApplyDiscounts: false,
    canCancelSales: false,
    canRefund: false,
    canSellWithNegativeStock: false,
    canViewStock: false,
  },
};

/** Horario por dia da semana ('0' = domingo ... '6' = sabado). `null` = fechado no dia.
 * Fechamento menor que a abertura = turno que passa da meia-noite. */
export type MenuOpeningHours = Record<string, [string, string] | null>;

/** Produto no cardapio: exibir, selo e ordem sao do cardapio (o preco segue no produto). */
@Schema({ _id: false })
export class MenuItem {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ default: false })
  active: boolean;

  /** Selo curto exibido no card ("Vegano", "Mais pedido"). */
  @Prop()
  tag?: string;

  /** Ordem de exibicao (menor primeiro; empate = nome). */
  @Prop({ default: 0 })
  order: number;

  /** Grupos de complementos oferecidos neste produto, na ordem de exibicao. */
  @Prop({ type: [Types.ObjectId], default: [] })
  optionGroupIds?: Types.ObjectId[];
}

/** Uma escolha dentro de um grupo de complementos ("Coca 350ml", "+ R$ 7,90"). */
@Schema()
export class MenuOption {
  _id?: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  /** Valor somado ao item (0 = sem custo, ex.: "Não preciso, obrigado"). */
  @Prop({ min: 0, default: 0 })
  price: number;

  @Prop({ default: true })
  active: boolean;
}

/**
 * Grupo de complementos reutilizavel entre produtos ("Bebidas", "Descartaveis").
 * min > 0 = obrigatorio; max = quantas opcoes o cliente pode marcar.
 */
@Schema()
export class MenuOptionGroup {
  _id?: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ min: 0, default: 0 })
  min: number;

  @Prop({ min: 1, default: 1 })
  max: number;

  @Prop({ default: true })
  active: boolean;

  @Prop({ type: [SchemaFactory.createForClass(MenuOption)], default: [] })
  options: MenuOption[];
}

/** Configuracao do cardapio digital publico (ver modulo menu/). */
@Schema({ _id: false })
export class MenuSettings {
  /** Identificador publico na URL do cardapio — unico entre negocios. */
  @Prop()
  slug?: string;

  @Prop({ default: false })
  enabled: boolean;

  @Prop()
  description?: string;

  @Prop()
  coverUrl?: string;

  @Prop()
  address?: string;

  /** So digitos, com DDD. */
  @Prop()
  whatsapp?: string;

  @Prop({ min: 0, default: 0 })
  deliveryFee: number;

  /** A loja entrega? false = so retirada no local. Ausente = entrega (padrao antigo). */
  @Prop({ default: true })
  deliveryEnabled: boolean;

  @Prop({ default: true })
  pickupEnabled: boolean;

  @Prop({ type: Object, default: () => ({}) })
  openingHours: MenuOpeningHours;

  @Prop()
  lastPublishedAt?: Date;

  @Prop({ default: 0 })
  publishedVersion: number;

  /** Slug do arquivo publicado — se o slug mudar, o arquivo antigo e apagado. */
  @Prop()
  publishedSlug?: string;

  /** Hash do conteudo publicado — base do aviso "alteracoes nao publicadas". */
  @Prop()
  publishedHash?: string;

  @Prop({ type: [MenuItem], default: [] })
  items: MenuItem[];

  @Prop({ type: [SchemaFactory.createForClass(MenuOptionGroup)], default: [] })
  optionGroups?: MenuOptionGroup[];

  /** Cor da marca no cardapio (#RRGGBB). Ausente = cor padrao do cardapio. */
  @Prop()
  themeColor?: string;

  /** @usuario, exibido em "Mais informações". */
  @Prop()
  instagram?: string;

  /** Formas de pagamento aceitas no cardapio (PaymentMethod). Vazio/ausente = todas. */
  @Prop({ type: [String] })
  acceptedPayments?: string[];
}

@Schema({ timestamps: true })
export class Business {
  @Prop({ required: true })
  name: string;

  @Prop()
  logoUrl: string;

  @Prop()
  businessType: string;

  @Prop()
  city: string;

  @Prop({ default: 'BRL' })
  currency: string;

  /** Fuso IANA do negocio — base de TODO calculo de dia/periodo (ver common/date/timezone.util). */
  @Prop({ default: 'America/Sao_Paulo' })
  timezone: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ type: Object, default: () => DEFAULT_PERMISSIONS })
  permissions: BusinessPermissions;

  @Prop({ type: MenuSettings })
  menu?: MenuSettings;
}

export const BusinessSchema = SchemaFactory.createForClass(Business);

BusinessSchema.index(
  { 'menu.slug': 1 },
  {
    unique: true,
    partialFilterExpression: { 'menu.slug': { $type: 'string' } },
  },
);
