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
}

export {
  OrderItem,
  OrderPayment,
  OrderStatusEvent,
  OrderDiscount,
  OrderRequestedPayment,
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

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId: Types.ObjectId;

  /* Snapshot do cliente no momento da encomenda: a folha impressa e o
   * historico precisam continuar corretos mesmo se o cadastro mudar depois. */
  @Prop({ required: true })
  customerName: string;

  @Prop()
  customerPhone?: string;

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
