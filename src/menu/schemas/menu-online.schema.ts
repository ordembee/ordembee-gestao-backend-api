import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MenuOnlineDocument = MenuOnline & Document;

/** Horario por dia da semana ('0' = domingo ... '6' = sabado). `null` = fechado no dia.
 * Fechamento menor que a abertura = turno que passa da meia-noite. */
export type MenuOpeningHours = Record<string, [string, string] | null>;

/** Quem faz a entrega do cardapio: a propria loja (taxa fixa) ou a Uber Direct (frete cotado). */
export enum DeliveryProvider {
  PROPRIA = 'PROPRIA',
  UBER = 'UBER',
}

/** Posicao de uma categoria no cardapio (menor primeiro; sem posicao = depois, por nome). */
@Schema({ _id: false })
export class MenuCategory {
  @Prop({ type: Types.ObjectId, ref: 'Category', required: true })
  categoryId: Types.ObjectId;

  @Prop({ default: 0 })
  order: number;
}

/** Produto no cardapio: exibir e complementos (preco e categoria seguem no produto). */
@Schema({ _id: false })
export class MenuItem {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ default: false })
  active: boolean;

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

/** Como o cliente recebe o pedido. Sem entrega e sem retirada nao ha como pedir. */
@Schema({ _id: false })
export class MenuDelivery {
  /** Quem entrega (so vale com `deliveryEnabled`). Credenciais em Business.config.uber. */
  @Prop({
    type: String,
    enum: DeliveryProvider,
    default: DeliveryProvider.PROPRIA,
  })
  deliveryProvider: DeliveryProvider;

  /** Taxa fixa da entrega propria. */
  @Prop({ min: 0, default: 0 })
  deliveryFee: number;

  @Prop({ default: true })
  deliveryEnabled: boolean;

  @Prop({ default: true })
  pickupEnabled: boolean;
}

@Schema({ _id: false })
export class MenuContact {
  /** Endereco da loja (texto livre, para retirada). */
  @Prop()
  address?: string;

  /** So digitos, com DDD. */
  @Prop()
  whatsapp?: string;
}

@Schema({ _id: false })
export class MenuSocialMedia {
  /** @usuario, exibido em "Mais informações". */
  @Prop()
  instagram?: string;
}

/** Imagens do cardapio — proprias do cardapio, independentes do logo do sistema. */
@Schema({ _id: false })
export class MenuImages {
  @Prop()
  coverUrl?: string;

  @Prop()
  logoUrl?: string;
}

@Schema({ _id: false })
export class MenuColors {
  /** Cor da marca no cardapio (#RRGGBB). Ausente = cor padrao do cardapio. */
  @Prop()
  themeColor?: string;
}

/** Como a loja funciona no cardapio: pagamento, entrega, contato e visual. */
@Schema({ _id: false })
export class MenuStore {
  /** Formas de pagamento aceitas (PaymentMethod). Vazio/ausente = todas. */
  @Prop({ type: [String] })
  acceptedPayments?: string[];

  @Prop({
    type: SchemaFactory.createForClass(MenuDelivery),
    default: () => ({}),
  })
  delivery: MenuDelivery;

  @Prop({
    type: SchemaFactory.createForClass(MenuContact),
    default: () => ({}),
  })
  contact: MenuContact;

  @Prop({
    type: SchemaFactory.createForClass(MenuSocialMedia),
    default: () => ({}),
  })
  socialMedia: MenuSocialMedia;

  @Prop({ type: SchemaFactory.createForClass(MenuImages), default: () => ({}) })
  images: MenuImages;

  @Prop({ type: SchemaFactory.createForClass(MenuColors), default: () => ({}) })
  colors: MenuColors;

  @Prop({ type: Object, default: () => ({}) })
  openingHours: MenuOpeningHours;
}

/** Textos exibidos no cardapio. Vazio = nao aparece. */
@Schema({ _id: false })
export class MenuLabelText {
  @Prop()
  description?: string;

  /** Linha pequena acima do titulo ("Feito hoje, com carinho"). */
  @Prop()
  highlightLabel?: string;

  /** Titulo acima das categorias ("O que vai adoçar seu dia?"). */
  @Prop()
  highlightTitle?: string;
}

/** Estado da ultima publicacao do JSON no Storage. */
@Schema({ _id: false })
export class MenuPublication {
  @Prop({ default: 0 })
  version: number;

  @Prop({ type: Date })
  lastPublishedAt?: Date | null;

  /** Slug do arquivo publicado — se o slug mudar, o arquivo antigo e apagado. */
  @Prop({ type: String })
  slug?: string | null;

  /** Hash do conteudo publicado — base do aviso "alteracoes nao publicadas". */
  @Prop({ type: String })
  hash?: string | null;
}

/**
 * Cardapio digital de um negocio (um documento por negocio). Tudo que e do
 * cardapio mora aqui; o Business guarda so o negocio e as integracoes.
 */
@Schema({ timestamps: true })
export class MenuOnline {
  @Prop({ type: Types.ObjectId, ref: 'Business', required: true })
  businessId: Types.ObjectId;

  /** Identificador publico na URL do cardapio — unico entre negocios. */
  @Prop()
  slug?: string;

  /** Ultima troca do slug (com cardapio ja no ar) — base do intervalo minimo entre trocas. */
  @Prop({ type: Date })
  slugChangedAt?: Date | null;

  @Prop({ default: false })
  enabled: boolean;

  /** Ordem das categorias no cardapio. */
  @Prop({ type: [SchemaFactory.createForClass(MenuCategory)], default: [] })
  categories: MenuCategory[];

  @Prop({ type: [SchemaFactory.createForClass(MenuItem)], default: [] })
  items: MenuItem[];

  @Prop({ type: [SchemaFactory.createForClass(MenuOptionGroup)], default: [] })
  optionGroups: MenuOptionGroup[];

  @Prop({ type: SchemaFactory.createForClass(MenuStore), default: () => ({}) })
  store: MenuStore;

  @Prop({
    type: SchemaFactory.createForClass(MenuLabelText),
    default: () => ({}),
  })
  labelText: MenuLabelText;

  @Prop({
    type: SchemaFactory.createForClass(MenuPublication),
    default: () => ({}),
  })
  publication: MenuPublication;
}

export const MenuOnlineSchema = SchemaFactory.createForClass(MenuOnline);

MenuOnlineSchema.index({ businessId: 1 }, { unique: true });
MenuOnlineSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: 'string' } } },
);
