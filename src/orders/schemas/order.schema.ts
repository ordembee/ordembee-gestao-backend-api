import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { PaymentMethod } from '../../common/enums/payment-method.enum';

export type OrderDocument = Order & Document;

/**
 * Fluxo da encomenda. PENDENTE -> EM_PRODUCAO -> PRONTO -> ENTREGUE, com
 * CANCELADA como saida de qualquer ponto antes da entrega. So a transicao para
 * ENTREGUE gera a venda (ver `OrdersService.deliver`).
 */
export enum OrderStatus {
  PENDENTE = 'PENDENTE',
  EM_PRODUCAO = 'EM_PRODUCAO',
  PRONTO = 'PRONTO',
  ENTREGUE = 'ENTREGUE',
  CANCELADA = 'CANCELADA',
}

/** Ordem do fluxo — usada para validar avanco/retrocesso de status. */
export const ORDER_STATUS_FLOW: OrderStatus[] = [
  OrderStatus.PENDENTE,
  OrderStatus.EM_PRODUCAO,
  OrderStatus.PRONTO,
  OrderStatus.ENTREGUE,
];

export enum OrderFulfillment {
  RETIRADA = 'RETIRADA',
  ENTREGA = 'ENTREGA',
}

/** Onde a encomenda nasceu: sistema interno ou cardapio digital publico. */
export enum OrderSource {
  INTERNO = 'INTERNO',
  CARDAPIO = 'CARDAPIO',
}

/** Sinal (entrada) ou quitacao no ato da entrega. */
export enum OrderPaymentKind {
  SINAL = 'SINAL',
  QUITACAO = 'QUITACAO',
}

@Schema({ _id: false })
class OrderComboComponent {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  productName: string;

  @Prop({ required: true, min: 1 })
  quantity: number;
}

/** Complemento escolhido no item (snapshot: nome e preco do momento do pedido). */
@Schema({ _id: false })
class OrderItemOption {
  @Prop({ required: true })
  groupName: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, min: 0, default: 0 })
  price: number;
}

@Schema({ _id: false })
class OrderItem {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  productName: string;

  @Prop({ required: true, min: 0 })
  unitPrice: number;

  @Prop({ required: true, min: 0, default: 0 })
  costPrice: number;

  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true, min: 0 })
  subtotal: number;

  @Prop({ required: true, default: 0 })
  profit: number;

  /** Receita do combo no momento da encomenda — base para devolver estoque. */
  @Prop({ type: [OrderComboComponent], default: [] })
  comboComponents: OrderComboComponent[];

  /** Observacao do item ("sem cebola", "escrever Feliz Natal"). */
  @Prop()
  notes?: string;

  /** Complementos escolhidos (cardapio digital). `unitPrice` ja inclui os precos deles. */
  @Prop({ type: [OrderItemOption], default: undefined })
  options?: OrderItemOption[];
}

@Schema({ _id: false })
class OrderPayment {
  @Prop({ type: String, enum: PaymentMethod, required: true })
  method: PaymentMethod;

  @Prop({ required: true, min: 0 })
  amount: number;

  @Prop({
    type: String,
    enum: OrderPaymentKind,
    default: OrderPaymentKind.SINAL,
  })
  kind: OrderPaymentKind;

  @Prop({ default: () => new Date() })
  paidAt: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  userId?: Types.ObjectId;
}

@Schema({ _id: false })
class OrderDiscount {
  /** Nome normalizado da campanha que concedeu o desconto (sem '#'). */
  @Prop({ required: true })
  campaign: string;

  @Prop({ required: true, min: 0, max: 100 })
  percent: number;

  /** Valor em reais ja abatido de `total`. */
  @Prop({ required: true, min: 0 })
  amount: number;
}

@Schema({ _id: false })
class OrderStatusEvent {
  @Prop({ type: String, enum: OrderStatus, required: true })
  status: OrderStatus;

  @Prop({ default: () => new Date() })
  at: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  userId?: Types.ObjectId;

  @Prop()
  userName?: string;
}

/**
 * Forma de pagamento que o cliente ESCOLHEU no cardapio. Nao e pagamento
 * registrado: o dinheiro so entra em `payments` quando alguem recebe de fato.
 */
@Schema({ _id: false })
class OrderRequestedPayment {
  @Prop({ type: String, enum: PaymentMethod, required: true })
  method: PaymentMethod;

  /** Bandeira do cartao ('visa', 'master', ...) — so para cartao. */
  @Prop()
  brand?: string;

  /** Troco para quanto (dinheiro). */
  @Prop({ min: 0 })
  changeFor?: number;

  /** Pix pago ANTES (entrega Uber): a loja confere o extrato e registra o pagamento. */
  @Prop()
  prepaid?: boolean;
}

/**
 * Cobranca no checkout da InfinitePay (pedido do cardapio pago antes). O
 * `orderNsu` e o nosso `externalRef`; o resto e preenchido quando o pagamento
 * e confirmado (webhook ou consulta `payment_check`).
 */
@Schema({ _id: false })
class OrderInfinitePay {
  @Prop({ required: true })
  orderNsu: string;

  @Prop()
  checkoutUrl?: string;

  /** Para onde o cliente volta depois de pagar (pagina do cardapio). */
  @Prop()
  redirectUrl?: string;

  @Prop()
  invoiceSlug?: string;

  @Prop()
  transactionNsu?: string;

  /** 'pix' | 'credit_card' */
  @Prop()
  captureMethod?: string;

  @Prop()
  installments?: number;

  @Prop()
  receiptUrl?: string;

  /**
   * Valor cobrado no link quando nao e o total do pedido (sinal de um pedido
   * criado no painel). Ausente = o link cobra o total.
   */
  @Prop({ min: 0 })
  chargeAmount?: number;

  /** Reais que a InfinitePay informou ter cobrado (pode incluir juros do parcelamento). */
  @Prop()
  paidAmount?: number;

  @Prop()
  paidAt?: Date;
}

/** Estados da entrega na Uber Direct (mesmos nomes da API). */
export const UBER_DELIVERY_STATUSES = [
  'pending',
  'pickup',
  'pickup_complete',
  'dropoff',
  'delivered',
  'canceled',
  'returned',
] as const;
export type UberDeliveryStatus = (typeof UBER_DELIVERY_STATUSES)[number];

/** Estados em que a corrida ainda esta valendo (nao da para pedir outra). */
export const UBER_ACTIVE_STATUSES: UberDeliveryStatus[] = [
  'pending',
  'pickup',
  'pickup_complete',
  'dropoff',
];

/** Endereco de entrega estruturado (o que a Uber precisa). */
@Schema({ _id: false })
class OrderDropoffAddress {
  @Prop({ required: true })
  cep: string;

  @Prop({ required: true })
  street: string;

  @Prop({ required: true })
  number: string;

  @Prop({ required: true })
  district: string;

  @Prop({ required: true })
  city: string;

  @Prop({ required: true })
  state: string;

  @Prop()
  complement?: string;
}

@Schema({ _id: false })
class OrderCourier {
  @Prop()
  name?: string;

  @Prop()
  phone?: string;

  @Prop()
  vehicleType?: string;

  @Prop()
  vehicleMake?: string;

  @Prop()
  vehicleModel?: string;

  @Prop()
  vehicleColor?: string;

  @Prop()
  licensePlate?: string;

  @Prop()
  photoUrl?: string;

  @Prop()
  rating?: number;

  @Prop()
  lat?: number;

  @Prop()
  lng?: number;

  @Prop()
  updatedAt?: Date;
}

@Schema({ _id: false })
class OrderDeliveryEvent {
  @Prop({ required: true })
  status: string;

  @Prop({ default: () => new Date() })
  at: Date;

  /** 'webhook' | 'sync' | 'operador'. */
  @Prop()
  source?: string;
}

/**
 * Entrega pela Uber Direct. Nasce no pedido do cardapio (cotacao que o
 * cliente pagou) e ganha `uberDeliveryId` quando o operador solicita o
 * entregador — com uma cotacao NOVA, porque a original expira em minutos.
 */
@Schema({ _id: false })
class OrderDelivery {
  @Prop({ required: true, default: 'UBER' })
  provider: 'UBER';

  /** Cotacao mostrada ao cliente no checkout. */
  @Prop({ required: true })
  quoteId: string;

  /** Frete que o cliente pagou (= `Order.deliveryFee` na criacao). */
  @Prop({ required: true, min: 0 })
  quotedFee: number;

  @Prop({
    type: SchemaFactory.createForClass(OrderDropoffAddress),
    required: true,
  })
  dropoff: OrderDropoffAddress;

  @Prop({ required: true })
  recipientName: string;

  /** E.164 (+5521999999999). */
  @Prop({ required: true })
  recipientPhone: string;

  @Prop()
  instructions?: string;

  @Prop()
  uberDeliveryId?: string;

  @Prop({ type: String, enum: UBER_DELIVERY_STATUSES })
  status?: UberDeliveryStatus;

  /** Valor que a Uber cobrou da loja na corrida solicitada. */
  @Prop({ min: 0 })
  fee?: number;

  @Prop()
  trackingUrl?: string;

  @Prop()
  pickupEta?: Date;

  @Prop()
  dropoffEta?: Date;

  @Prop({ type: SchemaFactory.createForClass(OrderCourier) })
  courier?: OrderCourier;

  @Prop()
  requestedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  requestedBy?: Types.ObjectId;

  @Prop()
  requestedByName?: string;

  /** Motivo do cancelamento/devolucao informado pela Uber. */
  @Prop()
  failureReason?: string;

  @Prop({
    type: [SchemaFactory.createForClass(OrderDeliveryEvent)],
    default: [],
  })
  events: OrderDeliveryEvent[];
}

export {
  OrderItem,
  OrderPayment,
  OrderStatusEvent,
  OrderDiscount,
  OrderRequestedPayment,
  OrderDelivery,
  OrderDropoffAddress,
  OrderCourier,
  OrderInfinitePay,
};

@Schema({ timestamps: true })
export class Order {
  /** Numero sequencial por negocio — e o que sai impresso na folha. */
  @Prop({ required: true })
  code: number;

  @Prop({ type: Types.ObjectId, ref: 'Business', required: true })
  businessId: Types.ObjectId;

  /** Quem registrou a encomenda. Ausente quando veio do cardapio digital (`source`). */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  userId?: Types.ObjectId;

  @Prop({ type: String, enum: OrderSource, default: OrderSource.INTERNO })
  source: OrderSource;

  /** Referencia do pedido no cardapio — chave de idempotencia (retry nao duplica). */
  @Prop()
  externalRef?: string;

  @Prop({ type: OrderRequestedPayment })
  requestedPayment?: OrderRequestedPayment;

  /** Entrega pela Uber Direct (so pedidos do cardapio com a loja em modo Uber). */
  @Prop({ type: SchemaFactory.createForClass(OrderDelivery) })
  delivery?: OrderDelivery;

  /** Pagamento online pela InfinitePay (substitui o Pix estatico quando a loja ativa). */
  @Prop({ type: SchemaFactory.createForClass(OrderInfinitePay) })
  infinitePay?: OrderInfinitePay;

  /** Trava curta do despacho da Uber (dois cliques nao pedem dois entregadores). */
  @Prop()
  dispatchLockedAt?: Date;

  /** Cliente tocou "Já paguei" no cardapio — aviso, nao comprovante. */
  @Prop()
  paymentClaimedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId: Types.ObjectId;

  /* Snapshot do cliente no momento da encomenda: a folha impressa e o
   * historico precisam continuar corretos mesmo se o cadastro mudar depois. */
  @Prop({ required: true })
  customerName: string;

  @Prop()
  customerPhone?: string;

  /** Opcional (cardapio): a InfinitePay usa no checkout. */
  @Prop()
  customerEmail?: string;

  @Prop()
  customerAddress?: string;

  @Prop({ type: [OrderItem], required: true })
  items: OrderItem[];

  /** Soma dos itens, sem a taxa de entrega. */
  @Prop({ required: true, min: 0 })
  itemsTotal: number;

  @Prop({ required: true, min: 0, default: 0 })
  deliveryFee: number;

  /** itemsTotal + deliveryFee - desconto da campanha. */
  @Prop({ required: true, min: 0 })
  total: number;

  /**
   * Desconto concedido por uma campanha, calculado sobre `itemsTotal`
   * (a taxa de entrega nao entra). So uma campanha desconta por encomenda: vence o
   * maior percentual, nao acumula (ver `common/campaigns/campaign.util.ts`).
   */
  @Prop({ type: OrderDiscount })
  discount?: OrderDiscount;

  @Prop({ required: true, default: 0 })
  totalProfit: number;

  /** Instante da entrega/retirada, gravado em UTC (fuso do negocio na UI). */
  @Prop({ required: true })
  deliveryAt: Date;

  /** false quando o cliente so informou o dia — a UI entao esconde a hora. */
  @Prop({ default: false })
  hasDeliveryTime: boolean;

  @Prop({
    type: String,
    enum: OrderFulfillment,
    default: OrderFulfillment.RETIRADA,
  })
  fulfillment: OrderFulfillment;

  @Prop({ type: String, enum: OrderStatus, default: OrderStatus.PENDENTE })
  status: OrderStatus;

  /**
   * Nomes de campanha normalizados (sem '#') — ver
   * `common/campaigns/campaign.util.ts`. O campo manteve o nome `tags` de
   * quando a entidade se chamava Tag: o rename foi so de codigo, sem migracao.
   */
  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop()
  notes?: string;

  @Prop({ type: [OrderPayment], default: [] })
  payments: OrderPayment[];

  @Prop({ type: [OrderStatusEvent], default: [] })
  statusHistory: OrderStatusEvent[];

  /** Venda gerada na entrega. Ausente enquanto a encomenda nao foi entregue. */
  @Prop({ type: Types.ObjectId, ref: 'Sale' })
  saleId?: Types.ObjectId;

  @Prop()
  deliveredAt?: Date;

  @Prop()
  cancelledAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  cancelledBy?: Types.ObjectId;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

// Webhook da Uber chega so com o id da corrida.
OrderSchema.index(
  { 'delivery.uberDeliveryId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'delivery.uberDeliveryId': { $type: 'string' } },
  },
);

// Webhook da InfinitePay chega so com o order_nsu (nosso UUID, nao adivinhavel).
OrderSchema.index(
  { 'infinitePay.orderNsu': 1 },
  { partialFilterExpression: { 'infinitePay.orderNsu': { $type: 'string' } } },
);

OrderSchema.index({ businessId: 1, code: 1 }, { unique: true });
OrderSchema.index({ businessId: 1, deliveryAt: 1 });
OrderSchema.index({ businessId: 1, status: 1, deliveryAt: 1 });
OrderSchema.index({ businessId: 1, customerId: 1 });
OrderSchema.index({ businessId: 1, tags: 1 });
// Feed do alerta de pedido novo (OrdersService.getMenuFeed).
OrderSchema.index({ businessId: 1, source: 1, createdAt: 1 });
OrderSchema.index(
  { businessId: 1, externalRef: 1 },
  {
    unique: true,
    partialFilterExpression: { externalRef: { $type: 'string' } },
  },
);
