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
  Order,
  OrderDocument,
  OrderFulfillment,
  OrderPaymentKind,
  OrderRequestedPayment,
  OrderSource,
  OrderStatus,
} from './schemas/order.schema';
import {
  OrderCounter,
  OrderCounterDocument,
} from './schemas/order-counter.schema';
import { CreateOrderDto, OrderItemDto, OrderPaymentDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { DeliverOrderDto } from './dto/deliver-order.dto';
import { AddOrderPaymentDto } from './dto/add-order-payment.dto';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  Customer,
  CustomerDocument,
} from '../customers/schemas/customer.schema';
import { StockMovementsService } from '../stock-movements/stock-movements.service';
import { MovementType } from '../stock-movements/schemas/stock-movement.schema';
import { PricingsService } from '../pricings/pricings.service';
import { PreparedCampaigns, CampaignsService } from '../campaigns/campaigns.service';
import { SalesService } from '../sales/sales.service';
import { BusinessService } from '../business/business.service';
import { PaymentMethod } from '../common/enums/payment-method.enum';
import {
  instantRangeFilter,
  zonedDateString,
  zonedStartOfDay,
  zonedTodayRange,
} from '../common/date/timezone.util';
import { normalizeCampaignName } from '../common/campaigns/campaign.util';

/** Status que ainda contam como "encomenda viva" (nem entregue nem cancelada). */
const OPEN_STATUSES = [
  OrderStatus.PENDENTE,
  OrderStatus.EM_PRODUCAO,
  OrderStatus.PRONTO,
];

/** Status que o endpoint de status pode aplicar — entrega e cancelamento tem rota propria. */
const MANUAL_STATUSES = OPEN_STATUSES;

/**
 * Pedido do cardapio nasce com `deliveryAt` = hora da chegada (o cliente pede
 * "o quanto antes"), entao sem folga ele ja apareceria atrasado ao chegar.
 * So conta como atrasado depois desse tempo. Mesma regra no front
 * (`isOrderLate` em utils/orders.ts).
 */
export const MENU_ORDER_LATE_GRACE_MS = 60 * 60 * 1000;

/** Filtro de "atrasada": em aberto e passou da hora (com a folga do cardapio). */
export function lateOrdersFilter(now: Date): Record<string, unknown> {
  return {
    status: { $in: OPEN_STATUSES },
    $or: [
      { source: { $ne: OrderSource.CARDAPIO }, deliveryAt: { $lt: now } },
      {
        source: OrderSource.CARDAPIO,
        deliveryAt: { $lt: new Date(now.getTime() - MENU_ORDER_LATE_GRACE_MS) },
      },
    ],
  };
}

interface BuiltItem {
  productId: Types.ObjectId;
  productName: string;
  unitPrice: number;
  costPrice: number;
  quantity: number;
  subtotal: number;
  profit: number;
  comboComponents: {
    productId: Types.ObjectId;
    productName: string;
    quantity: number;
  }[];
  notes?: string;
  options?: OrderItemOptionInput[];
}

/** Complemento ja resolvido (nome/preco) que acompanha o item — so pedidos do cardapio. */
export interface OrderItemOptionInput {
  groupName: string;
  name: string;
  price: number;
}

/** Quantidade de estoque a consumir (positivo) ou devolver (negativo) por produto. */
type StockDelta = Map<
  string,
  { productId: Types.ObjectId; productName: string; quantity: number }
>;

/** Baixa ja aplicada por `reserveStock` — base do historico e do estorno. */
interface StockReservation {
  productId: Types.ObjectId;
  productName: string;
  quantity: number;
  previousStock: number;
  newStock: number;
}

export interface OrderWithTotals {
  amountPaid: number;
  amountDue: number;
  isPaid: boolean;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(OrderCounter.name)
    private readonly counterModel: Model<OrderCounterDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
    private readonly stockMovementsService: StockMovementsService,
    private readonly pricingsService: PricingsService,
    private readonly campaignsService: CampaignsService,
    private readonly salesService: SalesService,
    private readonly businessService: BusinessService,
  ) {}

  /* ======================================================================
   * Helpers
   * ==================================================================== */

  /**
   * Custo efetivo de cada produto: o `custoFinal` em tempo real da precificacao
   * vinculada, ou o `costPrice` estatico. Gemeo de `SalesService.resolveCostPrices`
   * — produtos vinculados a uma precificacao nunca tem o custo persistido.
   */
  private async resolveCostPrices(
    businessId: string,
    products: ProductDocument[],
  ): Promise<Map<string, number>> {
    const pricingIds = products
      .filter((p) => p.pricingId)
      .map((p) => p.pricingId as Types.ObjectId);
    const pricings = await this.pricingsService.findManyByIds(
      businessId,
      pricingIds,
    );
    const byPricingId = new Map(pricings.map((pr) => [pr._id.toString(), pr]));

    const costByProductId = new Map<string, number>();
    for (const p of products) {
      const linked = p.pricingId
        ? byPricingId.get(p.pricingId.toString())
        : undefined;
      const cost =
        linked && linked.custoFinal !== null
          ? linked.custoFinal
          : Number(p.costPrice ?? 0);
      costByProductId.set(String(p._id), cost);
    }
    return costByProductId;
  }

  /** Monta os itens completos (nome, custo, lucro, receita de combo) a partir do DTO. */
  private async buildItems(
    businessId: string,
    dtoItems: (OrderItemDto & { options?: OrderItemOptionInput[] })[],
  ): Promise<BuiltItem[]> {
    const productIds = dtoItems.map((i) => new Types.ObjectId(i.productId));
    const products = await this.productModel
      .find({
        _id: { $in: productIds },
        businessId: new Types.ObjectId(businessId),
      })
      .select('costPrice pricingId stock name isCombo comboItems')
      .exec();

    const productMap = new Map<string, ProductDocument>(
      products.map((p) => [String(p._id), p]),
    );
    const costPriceMap = await this.resolveCostPrices(businessId, products);

    return dtoItems.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) {
        throw new BadRequestException(
          `Produto ${item.productId} não encontrado`,
        );
      }
      const costPrice = costPriceMap.get(item.productId) ?? 0;
      const subtotal = Math.round(item.unitPrice * item.quantity * 100) / 100;
      const profit =
        Math.round((item.unitPrice - costPrice) * item.quantity * 100) / 100;

      return {
        productId: new Types.ObjectId(item.productId),
        productName: product.name,
        unitPrice: item.unitPrice,
        costPrice,
        quantity: item.quantity,
        subtotal,
        profit,
        comboComponents: product.isCombo
          ? (product.comboItems ?? []).map((ci) => ({
              productId: ci.productId,
              productName: ci.productName,
              quantity: ci.quantity,
            }))
          : [],
        notes: item.notes,
        ...(item.options?.length ? { options: item.options } : {}),
      };
    });
  }

  /**
   * Quanto cada produto deve sair do estoque por causa desta lista de itens.
   * Combos nao movimentam a si mesmos — movimentam os componentes, na mesma
   * regra usada pelo PDV (`SalesService.create`).
   */
  private buildStockDelta(items: BuiltItem[]): StockDelta {
    const delta: StockDelta = new Map();
    const add = (
      productId: Types.ObjectId,
      productName: string,
      quantity: number,
    ) => {
      const key = String(productId);
      const existing = delta.get(key);
      if (existing) existing.quantity += quantity;
      else delta.set(key, { productId, productName, quantity });
    };

    for (const item of items) {
      if (item.comboComponents.length > 0) {
        for (const component of item.comboComponents) {
          add(
            component.productId,
            component.productName,
            component.quantity * item.quantity,
          );
        }
      } else {
        add(item.productId, item.productName, item.quantity);
      }
    }
    return delta;
  }

  /** `next - previous`, por produto. Entradas que se anulam somem do resultado. */
  private diffStockDelta(next: StockDelta, previous: StockDelta): StockDelta {
    const diff: StockDelta = new Map();
    for (const [key, entry] of next) {
      diff.set(key, { ...entry });
    }
    for (const [key, entry] of previous) {
      const existing = diff.get(key);
      if (existing) existing.quantity -= entry.quantity;
      else diff.set(key, { ...entry, quantity: -entry.quantity });
    }
    for (const [key, entry] of diff) {
      if (entry.quantity === 0) diff.delete(key);
    }
    return diff;
  }

  /**
   * Baixa CONDICIONAL do estoque (pedidos do cardapio): cada produto
   * controlado so desce se tiver a quantidade inteira (`stock >= qty`), num
   * update atomico — dois pedidos simultaneos nao furam o estoque. Se algum
   * faltar, desfaz o que ja baixou e recusa sem dizer quanto resta.
   * Sem controle de estoque (-1) nao entra. Pedidos internos seguem em
   * `applyStockDelta`, que pode vender alem do estoque.
   */
  private async reserveStock(
    businessId: string,
    delta: StockDelta,
  ): Promise<StockReservation[]> {
    const entries = Array.from(delta.values()).filter((e) => e.quantity > 0);
    if (entries.length === 0) return [];
    const bizObjectId = new Types.ObjectId(businessId);
    const tracked = await this.productModel
      .find({
        _id: { $in: entries.map((e) => e.productId) },
        businessId: bizObjectId,
        stock: { $ne: -1 },
      })
      .select('_id')
      .lean()
      .exec();
    const trackedIds = new Set(tracked.map((p) => String(p._id)));

    const reserved: StockReservation[] = [];
    for (const entry of entries) {
      if (!trackedIds.has(String(entry.productId))) continue;
      const before = await this.productModel
        .findOneAndUpdate(
          {
            _id: entry.productId,
            businessId: bizObjectId,
            stock: { $gte: entry.quantity },
          },
          { $inc: { stock: -entry.quantity } },
          { new: false, projection: { stock: 1, name: 1 } },
        )
        .lean<{ stock: number; name: string }>()
        .exec();
      if (!before) {
        await this.releaseStock(businessId, reserved);
        throw new ConflictException({
          statusCode: 409,
          reason: 'INSUFFICIENT_STOCK',
          message: `Quantidade indisponível para ${entry.productName}`,
        });
      }
      reserved.push({
        productId: entry.productId,
        productName: before.name ?? entry.productName,
        quantity: entry.quantity,
        previousStock: before.stock,
        newStock: before.stock - entry.quantity,
      });
    }
    return reserved;
  }

  /** Estorno de `reserveStock` (pedido nao chegou a ser criado). */
  private async releaseStock(
    businessId: string,
    reserved: StockReservation[],
  ): Promise<void> {
    if (!reserved.length) return;
    const bizObjectId = new Types.ObjectId(businessId);
    await this.productModel.bulkWrite(
      reserved.map((r) => ({
        updateOne: {
          filter: { _id: r.productId, businessId: bizObjectId },
          update: { $inc: { stock: r.quantity } },
        },
      })),
    );
  }

  /**
   * Aplica o delta no estoque e grava o historico.
   * quantidade > 0 = consumir (movimento `encomenda`);
   * quantidade < 0 = devolver (movimento `cancelamento`).
   * Produtos com `stock === -1` (sem controle de estoque) sao ignorados.
   */
  private async applyStockDelta(
    businessId: string,
    userId: Types.ObjectId | undefined,
    order: { _id: Types.ObjectId; code: number },
    delta: StockDelta,
    reason: string,
  ): Promise<void> {
    const entries = Array.from(delta.values()).filter((e) => e.quantity !== 0);
    if (entries.length === 0) return;

    const bizObjectId = new Types.ObjectId(businessId);
    const tracked = await this.productModel
      .find({
        _id: { $in: entries.map((e) => e.productId) },
        businessId: bizObjectId,
        stock: { $gte: 0 },
      })
      .select('stock name')
      .exec();
    const stockMap = new Map(tracked.map((p) => [String(p._id), p]));
    const applicable = entries.filter((e) => stockMap.has(String(e.productId)));
    if (applicable.length === 0) return;

    await this.productModel.bulkWrite(
      applicable.map(({ productId, quantity }) => ({
        updateOne: {
          filter: { _id: productId, businessId: bizObjectId },
          update: { $inc: { stock: -quantity } },
        },
      })),
    );

    await Promise.all(
      applicable.map(({ productId, productName, quantity }) => {
        const product = stockMap.get(String(productId));
        const previousStock = product?.stock ?? 0;
        const newStock = Math.max(0, previousStock - quantity);
        return this.stockMovementsService.recordSaleMovement(
          {
            productId,
            productName: product?.name ?? productName,
            businessId: bizObjectId,
            userId,
            type:
              quantity > 0 ? MovementType.ENCOMENDA : MovementType.CANCELAMENTO,
            quantity: Math.abs(quantity),
            reason: `${reason} #${order.code}`,
            orderId: order._id,
          },
          previousStock,
          newStock,
        );
      }),
    );
  }

  /** Numero sequencial por negocio, atomico. */
  private async nextCode(businessId: string): Promise<number> {
    const counter = await this.counterModel
      .findOneAndUpdate(
        { businessId: new Types.ObjectId(businessId) },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .exec();
    return counter.seq;
  }

  /** Instante da entrega a partir de 'YYYY-MM-DD' + 'HH:mm', no fuso do negocio. */
  private buildDeliveryAt(
    ymd: string,
    time: string | null | undefined,
    tz: string,
  ): Date {
    const start = zonedStartOfDay(ymd, tz);
    if (!time) return start;
    const [hours = 0, minutes = 0] = time.split(':').map(Number);
    return new Date(start.getTime() + (hours * 60 + minutes) * 60_000);
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /**
   * Campos derivados do extrato de pagamentos. Nunca persistidos: quem paga
   * parcelado muda o saldo, e um numero gravado ficaria velho. Aplicado em
   * TODO metodo que devolve a encomenda (create/findAll/findOne/update/...).
   */
  private withTotals(order: OrderDocument): Order & OrderWithTotals {
    const obj = order.toObject() as Order & OrderWithTotals;
    const amountPaid = this.round(
      (order.payments ?? []).reduce((sum, p) => sum + (p.amount ?? 0), 0),
    );
    obj.amountPaid = amountPaid;
    obj.amountDue = Math.max(0, this.round(order.total - amountPaid));
    obj.isPaid = obj.amountDue <= 0.009;
    return obj;
  }

  private mapWithTotals(orders: OrderDocument[]): (Order & OrderWithTotals)[] {
    return orders.map((o) => this.withTotals(o));
  }

  private amountPaidOf(order: OrderDocument): number {
    return this.round(
      (order.payments ?? []).reduce((sum, p) => sum + (p.amount ?? 0), 0),
    );
  }

  private async requireUser(firebaseUid: string): Promise<UserDocument> {
    const user = await this.userModel.findOne({ firebaseUid }).exec();
    if (!user) throw new NotFoundException('Usuário não encontrado');
    return user;
  }

  private async requireOrder(
    id: string,
    businessId: string,
  ): Promise<OrderDocument> {
    const order = await this.orderModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .exec();
    if (!order) {
      this.logger.warn(
        `Encomenda não encontrada: id=${id} | negócio: ${businessId}`,
      );
      throw new NotFoundException('Encomenda não encontrada');
    }
    return order;
  }

  private async requireCustomer(
    customerId: string,
    businessId: string,
  ): Promise<CustomerDocument> {
    const customer = await this.customerModel
      .findOne({
        _id: customerId,
        businessId: new Types.ObjectId(businessId),
        isActive: true,
      })
      .exec();
    if (!customer) throw new NotFoundException('Cliente não encontrado');
    return customer;
  }

  private assertEditable(order: OrderDocument): void {
    if (order.status === OrderStatus.CANCELADA) {
      throw new BadRequestException(
        'Esta encomenda foi cancelada e não pode mais ser alterada',
      );
    }
    if (order.status === OrderStatus.ENTREGUE) {
      throw new BadRequestException(
        'Esta encomenda já foi entregue e virou venda — não pode mais ser alterada',
      );
    }
  }

  /* ======================================================================
   * CRUD
   * ==================================================================== */

  async create(
    firebaseUid: string,
    businessId: string,
    dto: CreateOrderDto,
  ): Promise<Order & OrderWithTotals> {
    const [user, customer, tz] = await Promise.all([
      this.requireUser(firebaseUid),
      this.requireCustomer(dto.customerId, businessId),
      this.businessService.getTimezone(businessId),
    ]);

    const items = await this.buildItems(businessId, dto.items);
    const itemsTotal = this.round(
      items.reduce((sum, item) => sum + item.subtotal, 0),
    );
    const deliveryFee = this.round(dto.deliveryFee ?? 0);

    // O desconto da campaign incide so nos itens — taxa de entrega nao entra.
    const preparedTags = await this.campaignsService.prepareForDocument(
      businessId,
      dto.tags,
      itemsTotal,
    );
    const { tags, discount } = preparedTags;

    const total = this.round(
      itemsTotal + deliveryFee - (discount?.amount ?? 0),
    );
    const totalProfit = this.round(
      items.reduce((sum, item) => sum + item.profit, 0) -
        (discount?.amount ?? 0),
    );

    const payments = (dto.payments ?? []).filter((p) => p.amount > 0);
    this.assertPaymentsFit(payments, total, 0);
    const deliveryAt = this.buildDeliveryAt(
      dto.deliveryDate,
      dto.deliveryTime,
      tz,
    );
    const code = await this.nextCode(businessId);

    const order = await this.orderModel.create({
      code,
      businessId: new Types.ObjectId(businessId),
      userId: user._id,
      customerId: customer._id,
      customerName: customer.name,
      customerPhone: customer.phone,
      customerAddress: dto.customerAddress ?? customer.address,
      items,
      itemsTotal,
      deliveryFee,
      total,
      discount: discount ?? undefined,
      totalProfit,
      deliveryAt,
      hasDeliveryTime: !!dto.deliveryTime,
      fulfillment: dto.fulfillment ?? OrderFulfillment.RETIRADA,
      status: OrderStatus.PENDENTE,
      tags,
      notes: dto.notes,
      payments: payments.map((p) => ({
        method: p.method,
        amount: this.round(p.amount),
        kind: OrderPaymentKind.SINAL,
        paidAt: new Date(),
        userId: user._id,
      })),
      statusHistory: [
        {
          status: OrderStatus.PENDENTE,
          at: new Date(),
          userId: user._id,
          userName: user.displayName,
        },
      ],
    });

    // So agora a campanha consome utilizacao: a encomenda ja existe.
    await this.campaignsService.commitUsage(businessId, preparedTags);

    // Aceitar a encomenda ja reserva o estoque — mesmo efeito de uma venda.
    await this.applyStockDelta(
      businessId,
      user._id as Types.ObjectId,
      { _id: order._id as Types.ObjectId, code },
      this.buildStockDelta(items),
      'Encomenda',
    );

    this.logger.log(
      `Encomenda criada: #${code} (${order._id.toString()}) | negócio: ${businessId} | total: ${total} | entrega: ${deliveryAt.toISOString()}`,
    );
    return this.withTotals(order);
  }

  /** Pedido do cardapio ja criado com este `orderRef` (retry idempotente). */
  async findMenuOrderByRef(
    businessId: string,
    externalRef: string,
  ): Promise<{ code: number; total: number } | null> {
    const order = await this.orderModel
      .findOne({ businessId: new Types.ObjectId(businessId), externalRef })
      .select('code total')
      .lean<{ code: number; total: number }>()
      .exec();
    return order ? { code: order.code, total: order.total } : null;
  }

  /**
   * Pedidos do cardapio que a loja recebeu desde `since` (qualquer status:
   * pedido falso cancelado tambem conta). Usa o indice (businessId, source, createdAt).
   */
  countMenuOrdersSince(businessId: string, since: Date): Promise<number> {
    return this.orderModel
      .countDocuments({
        businessId: new Types.ObjectId(businessId),
        source: OrderSource.CARDAPIO,
        createdAt: { $gte: since },
      })
      .exec();
  }

  /**
   * Encomenda vinda do cardapio digital (rota interna, sem usuario logado).
   * Quem chama ja validou loja/produtos e resolveu o cliente; os `unitPrice`
   * aqui SAO os do banco — nunca o preco enviado pelo cliente.
   * Idempotente por `externalRef`: um retry devolve a encomenda ja criada.
   */
  async createFromMenu(input: {
    businessId: string;
    externalRef: string;
    customer: CustomerDocument;
    items: (OrderItemDto & { options?: OrderItemOptionInput[] })[];
    fulfillment: OrderFulfillment;
    deliveryFee: number;
    customerAddress?: string;
    requestedPayment: OrderRequestedPayment;
    notes?: string;
  }): Promise<Order & OrderWithTotals> {
    const { businessId, externalRef, customer } = input;
    const bizObjectId = new Types.ObjectId(businessId);

    const existing = await this.orderModel
      .findOne({ businessId: bizObjectId, externalRef })
      .exec();
    if (existing) {
      this.logger.warn(
        `Pedido do cardápio repetido (idempotente): ref=${externalRef} | #${existing.code}`,
      );
      return this.withTotals(existing);
    }

    const items = await this.buildItems(businessId, input.items);
    const itemsTotal = this.round(
      items.reduce((sum, item) => sum + item.subtotal, 0),
    );
    const deliveryFee = this.round(input.deliveryFee);
    const total = this.round(itemsTotal + deliveryFee);
    const totalProfit = this.round(
      items.reduce((sum, item) => sum + item.profit, 0),
    );
    const now = new Date();
    // Reserva antes de criar: sem estoque, nem gasta numero de pedido.
    const reserved = await this.reserveStock(
      businessId,
      this.buildStockDelta(items),
    );
    let code: number;
    let order: OrderDocument;
    try {
      code = await this.nextCode(businessId);
      order = await this.orderModel.create({
        code,
        businessId: bizObjectId,
        source: OrderSource.CARDAPIO,
        externalRef,
        customerId: customer._id,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerAddress: input.customerAddress,
        items,
        itemsTotal,
        deliveryFee,
        total,
        totalProfit,
        deliveryAt: now,
        hasDeliveryTime: true,
        fulfillment: input.fulfillment,
        status: OrderStatus.PENDENTE,
        tags: [],
        notes: input.notes,
        payments: [],
        requestedPayment: input.requestedPayment,
        statusHistory: [
          {
            status: OrderStatus.PENDENTE,
            at: now,
            userName: 'Cardápio digital',
          },
        ],
      });
    } catch (err) {
      await this.releaseStock(businessId, reserved);
      // Dois retries simultaneos: o indice unico (businessId, externalRef) barra o segundo.
      const duplicate =
        (err as { code?: number }).code === 11000
          ? await this.orderModel
              .findOne({ businessId: bizObjectId, externalRef })
              .exec()
          : null;
      if (duplicate) return this.withTotals(duplicate);
      throw err;
    }

    await Promise.all(
      reserved.map((r) =>
        this.stockMovementsService.recordSaleMovement(
          {
            productId: r.productId,
            productName: r.productName,
            businessId: bizObjectId,
            type: MovementType.ENCOMENDA,
            quantity: r.quantity,
            reason: `Encomenda (cardápio) #${code}`,
            orderId: order._id as Types.ObjectId,
          },
          r.previousStock,
          r.newStock,
        ),
      ),
    );

    this.logger.log(
      `Encomenda do cardápio: #${code} (${order._id.toString()}) | negócio: ${businessId} | total: ${total} | ref: ${externalRef}`,
    );
    return this.withTotals(order);
  }

  /**
   * Feed leve para o alerta de pedido novo: so pedidos do cardapio, so os
   * campos do aviso. `since` e limitado as ultimas 24h para a consulta nunca
   * varrer o historico; o cliente reenvia com uma folga e deduplica por id.
   */
  async getMenuFeed(
    businessId: string,
    since?: string,
  ): Promise<{
    serverTime: string;
    orders: { _id: string; code: number; customerName: string; total: number; fulfillment: OrderFulfillment; createdAt: string }[];
  }> {
    const now = new Date();
    const floor = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const parsed = since ? new Date(since) : now;
    const from = isNaN(parsed.getTime()) || parsed < floor ? floor : parsed;

    const orders = await this.orderModel
      .find({
        businessId: new Types.ObjectId(businessId),
        source: OrderSource.CARDAPIO,
        createdAt: { $gt: from },
      })
      .sort({ createdAt: 1 })
      .limit(20)
      .select('code customerName total fulfillment createdAt')
      .lean<{ _id: Types.ObjectId; code: number; customerName: string; total: number; fulfillment: OrderFulfillment; createdAt: Date }[]>()
      .exec();

    return {
      serverTime: now.toISOString(),
      orders: orders.map((o) => ({
        _id: String(o._id),
        code: o.code,
        customerName: o.customerName,
        total: o.total,
        fulfillment: o.fulfillment,
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }

  async findAll(
    businessId: string,
    params: {
      page: number;
      limit: number;
      scope?: 'all' | 'today' | 'deliveredToday' | 'open' | 'late';
      status?: string;
      campaign?: string;
      customerId?: string;
      search?: string;
      dateFrom?: string;
      dateTo?: string;
    },
  ): Promise<{
    data: (Order & OrderWithTotals)[];
    total: number;
    totalPages: number;
  }> {
    const { page, limit, scope, status, campaign, customerId, search } = params;
    const tz = await this.businessService.getTimezone(businessId);
    const filter: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
    };

    // Mais novo primeiro (pedido do usuario): o que acabou de chegar fica no
    // topo. "Entregues hoje" segue pela hora da entrega, mais recente no topo.
    let sort: Record<string, 1 | -1> = { createdAt: -1, _id: -1 };

    if (scope === 'today') {
      const { start, end } = zonedTodayRange(tz);
      filter.deliveryAt = { $gte: start, $lte: end };
      filter.status = { $ne: OrderStatus.CANCELADA };
    } else if (scope === 'deliveredToday') {
      const { start, end } = zonedTodayRange(tz);
      filter.status = OrderStatus.ENTREGUE;
      filter.deliveredAt = { $gte: start, $lte: end };
      sort = { deliveredAt: -1 };
    } else if (scope === 'open') {
      filter.status = { $in: OPEN_STATUSES };
    } else if (scope === 'late') {
      // $and: a busca abaixo tambem usa $or.
      filter.$and = [lateOrdersFilter(new Date())];
    }

    const dateFilter = instantRangeFilter(params.dateFrom, params.dateTo, tz);
    if (dateFilter) filter.deliveryAt = dateFilter;
    if (status) filter.status = status;
    if (customerId) filter.customerId = new Types.ObjectId(customerId);
    if (campaign) {
      const normalized = normalizeCampaignName(campaign);
      if (normalized) filter.tags = normalized;
    }
    if (search) {
      const asNumber = Number(search.replace('#', '').trim());
      const or: Record<string, unknown>[] = [
        { customerName: { $regex: search, $options: 'i' } },
        { customerPhone: { $regex: search, $options: 'i' } },
      ];
      if (Number.isInteger(asNumber) && asNumber > 0) or.push({ code: asNumber });
      filter.$or = or;
    }

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('userId', 'displayName email')
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    return {
      data: this.mapWithTotals(data),
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async findOne(
    id: string,
    businessId: string,
  ): Promise<Order & OrderWithTotals> {
    const order = await this.orderModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .populate('userId', 'displayName email')
      .exec();
    if (!order) throw new NotFoundException('Encomenda não encontrada');
    return this.withTotals(order);
  }

  /** Contadores das abas da tela — uma unica ida ao banco. */
  async getSummary(businessId: string): Promise<{
    open: number;
    today: number;
    deliveredToday: number;
    late: number;
    todayRevenue: number;
    openAmountDue: number;
  }> {
    const tz = await this.businessService.getTimezone(businessId);
    const { start, end } = zonedTodayRange(tz);
    const now = new Date();
    const bizObjectId = new Types.ObjectId(businessId);

    const [result] = await this.orderModel.aggregate([
      { $match: { businessId: bizObjectId } },
      {
        $facet: {
          open: [{ $match: { status: { $in: OPEN_STATUSES } } }, { $count: 'n' }],
          today: [
            {
              $match: {
                deliveryAt: { $gte: start, $lte: end },
                status: { $ne: OrderStatus.CANCELADA },
              },
            },
            { $count: 'n' },
          ],
          deliveredToday: [
            {
              $match: {
                status: OrderStatus.ENTREGUE,
                deliveredAt: { $gte: start, $lte: end },
              },
            },
            { $group: { _id: null, n: { $sum: 1 }, revenue: { $sum: '$total' } } },
          ],
          late: [{ $match: lateOrdersFilter(now) }, { $count: 'n' }],
          due: [
            { $match: { status: { $in: OPEN_STATUSES } } },
            {
              $group: {
                _id: null,
                total: { $sum: '$total' },
                paid: { $sum: { $sum: '$payments.amount' } },
              },
            },
          ],
        },
      },
    ]);

    const raw = (result ?? {}) as Record<string, { n?: number; revenue?: number; total?: number; paid?: number }[]>;
    const first = (key: string) => raw[key]?.[0] ?? {};

    return {
      open: first('open').n ?? 0,
      today: first('today').n ?? 0,
      deliveredToday: first('deliveredToday').n ?? 0,
      late: first('late').n ?? 0,
      todayRevenue: this.round(first('deliveredToday').revenue ?? 0),
      openAmountDue: Math.max(
        0,
        this.round((first('due').total ?? 0) - (first('due').paid ?? 0)),
      ),
    };
  }

  async update(
    id: string,
    businessId: string,
    firebaseUid: string,
    dto: UpdateOrderDto,
  ): Promise<Order & OrderWithTotals> {
    const order = await this.requireOrder(id, businessId);
    this.assertEditable(order);
    const user = await this.requireUser(firebaseUid);

    if (dto.customerId && String(order.customerId) !== dto.customerId) {
      const customer = await this.requireCustomer(dto.customerId, businessId);
      order.customerId = customer._id as Types.ObjectId;
      order.customerName = customer.name;
      order.customerPhone = customer.phone;
      order.customerAddress = customer.address;
    }
    if (dto.customerAddress !== undefined) {
      order.customerAddress = dto.customerAddress;
    }

    if (dto.deliveryDate !== undefined || dto.deliveryTime !== undefined) {
      const tz = await this.businessService.getTimezone(businessId);
      const ymd = dto.deliveryDate ?? zonedDateString(order.deliveryAt, tz);
      // `deliveryTime` ausente mantem a hora atual; `null` limpa a hora.
      const time =
        dto.deliveryTime === undefined
          ? order.hasDeliveryTime
            ? new Intl.DateTimeFormat('en-GB', {
                timeZone: tz,
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
              }).format(order.deliveryAt)
            : null
          : dto.deliveryTime;
      order.deliveryAt = this.buildDeliveryAt(ymd, time, tz);
      order.hasDeliveryTime = !!time;
    }

    if (dto.fulfillment !== undefined) order.fulfillment = dto.fulfillment;
    if (dto.notes !== undefined) order.notes = dto.notes;

    let stockDelta: StockDelta | null = null;
    if (dto.items) {
      const previous = this.buildStockDelta(
        order.items as unknown as BuiltItem[],
      );
      const items = await this.buildItems(businessId, dto.items);
      stockDelta = this.diffStockDelta(this.buildStockDelta(items), previous);
      order.items = items as unknown as OrderDocument['items'];
      order.itemsTotal = this.round(
        items.reduce((sum, item) => sum + item.subtotal, 0),
      );
      // `totalProfit` e recalculado adiante, junto com o desconto.
    }

    if (dto.deliveryFee !== undefined) {
      order.deliveryFee = this.round(dto.deliveryFee);
    }

    // Tags e desconto vem depois dos itens: o percentual incide sobre o
    // subtotal novo. Campaign que ja estava na encomenda nao e revalidada — uma
    // campanha encerrada ontem nao pode travar a correcao de hoje.
    let preparedTags: PreparedCampaigns | null = null;
    if (dto.tags !== undefined) {
      preparedTags = await this.campaignsService.prepareForDocument(
        businessId,
        dto.tags,
        order.itemsTotal,
        order.tags ?? [],
      );
      order.tags = preparedTags.tags;
      order.discount = preparedTags.discount
        ? (preparedTags.discount as OrderDocument['discount'])
        : undefined;
    } else if (order.discount) {
      // So os itens mudaram: o percentual continua, o valor acompanha.
      order.discount.amount = this.round(
        (order.itemsTotal * order.discount.percent) / 100,
      );
    }

    order.total = this.round(
      order.itemsTotal + order.deliveryFee - (order.discount?.amount ?? 0),
    );
    order.totalProfit = this.round(
      (order.items ?? []).reduce((sum, item) => sum + item.profit, 0) -
        (order.discount?.amount ?? 0),
    );

    // O que ja foi pago nao pode passar do novo total (ex.: removeram itens).
    const amountPaid = this.amountPaidOf(order);
    if (amountPaid - order.total > 0.009) {
      throw new BadRequestException(
        `O total (${order.total.toFixed(2)}) ficou menor que o valor já pago (${amountPaid.toFixed(2)}). Ajuste os itens ou estorne o pagamento.`,
      );
    }

    await order.save();

    if (preparedTags) {
      await this.campaignsService.commitUsage(businessId, preparedTags);
    }

    if (stockDelta && stockDelta.size > 0) {
      await this.applyStockDelta(
        businessId,
        user._id as Types.ObjectId,
        { _id: order._id as Types.ObjectId, code: order.code },
        stockDelta,
        'Ajuste de encomenda',
      );
    }

    this.logger.log(
      `Encomenda atualizada: #${order.code} | negócio: ${businessId} | total: ${order.total}`,
    );
    return this.findOne(id, businessId);
  }

  /* ======================================================================
   * Status, pagamento, entrega e cancelamento
   * ==================================================================== */

  async updateStatus(
    id: string,
    businessId: string,
    firebaseUid: string,
    status: OrderStatus,
  ): Promise<Order & OrderWithTotals> {
    if (!MANUAL_STATUSES.includes(status)) {
      throw new BadRequestException(
        status === OrderStatus.ENTREGUE
          ? 'Use a ação "Entregar" para concluir a encomenda e registrar a venda'
          : 'Use a ação "Cancelar" para cancelar a encomenda',
      );
    }

    const order = await this.requireOrder(id, businessId);
    this.assertEditable(order);
    const user = await this.requireUser(firebaseUid);

    if (order.status !== status) {
      order.status = status;
      order.statusHistory.push({
        status,
        at: new Date(),
        userId: user._id as Types.ObjectId,
        userName: user.displayName,
      });
      await order.save();
      this.logger.log(
        `Encomenda #${order.code} -> ${status} | negócio: ${businessId}`,
      );
    }

    return this.findOne(id, businessId);
  }

  /** Sinal ou parcela paga antes da entrega. */
  async addPayment(
    id: string,
    businessId: string,
    firebaseUid: string,
    dto: AddOrderPaymentDto,
  ): Promise<Order & OrderWithTotals> {
    const order = await this.requireOrder(id, businessId);
    this.assertEditable(order);
    const user = await this.requireUser(firebaseUid);

    this.assertPaymentsFit([dto], order.total, this.amountPaidOf(order));

    order.payments.push({
      method: dto.method,
      amount: this.round(dto.amount),
      kind: OrderPaymentKind.SINAL,
      paidAt: new Date(),
      userId: user._id as Types.ObjectId,
    });
    await order.save();

    this.logger.log(
      `Pagamento registrado na encomenda #${order.code}: ${dto.method} ${dto.amount} | negócio: ${businessId}`,
    );
    return this.findOne(id, businessId);
  }

  private assertPaymentsFit(
    payments: OrderPaymentDto[] | AddOrderPaymentDto[],
    total: number,
    alreadyPaid: number,
  ): void {
    const sum = payments.reduce((acc, p) => acc + (p.amount ?? 0), 0);
    if (sum <= 0) return;
    if (alreadyPaid + sum - total > 0.009) {
      const remaining = Math.max(0, this.round(total - alreadyPaid));
      throw new BadRequestException(
        `Valor acima do que falta pagar (R$ ${remaining.toFixed(2)})`,
      );
    }
  }

  /**
   * Entrega a encomenda e registra a venda do dia.
   *
   * O estoque NAO e mexido aqui — ja saiu quando a encomenda foi aceita. Se
   * depois da quitacao ainda sobrar saldo, o restante entra na venda como
   * parcela FIADO, caindo no controle de dívida do cliente que ja existe.
   */
  async deliver(
    id: string,
    businessId: string,
    firebaseUid: string,
    dto: DeliverOrderDto,
  ): Promise<Order & OrderWithTotals> {
    const order = await this.requireOrder(id, businessId);
    this.assertEditable(order);
    const user = await this.requireUser(firebaseUid);

    const settlement = (dto.payments ?? []).filter((p) => p.amount > 0);
    this.assertPaymentsFit(settlement, order.total, this.amountPaidOf(order));

    const now = new Date();
    for (const payment of settlement) {
      order.payments.push({
        method: payment.method,
        amount: this.round(payment.amount),
        kind: OrderPaymentKind.QUITACAO,
        paidAt: now,
        userId: user._id as Types.ObjectId,
      });
    }

    // Extrato da venda: uma linha por forma de pagamento (sinal + quitacao
    // somados), mais o que sobrou como fiado.
    const byMethod = new Map<PaymentMethod, number>();
    for (const payment of order.payments) {
      byMethod.set(
        payment.method,
        this.round((byMethod.get(payment.method) ?? 0) + payment.amount),
      );
    }
    const paid = this.amountPaidOf(order);
    const remaining = Math.max(0, this.round(order.total - paid));
    if (remaining > 0.009) {
      byMethod.set(
        PaymentMethod.FIADO,
        this.round((byMethod.get(PaymentMethod.FIADO) ?? 0) + remaining),
      );
    }
    const salePayments = Array.from(byMethod.entries())
      .filter(([, amount]) => amount > 0)
      .map(([method, amount]) => ({ method, amount }));
    if (salePayments.length === 0) {
      salePayments.push({ method: PaymentMethod.DINHEIRO, amount: 0 });
    }

    const sale = await this.salesService.createFromOrder({
      businessId,
      userId: user._id as Types.ObjectId,
      orderId: order._id as Types.ObjectId,
      items: order.items.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        unitPrice: item.unitPrice,
        costPrice: item.costPrice,
        quantity: item.quantity,
        subtotal: item.subtotal,
        profit: item.profit,
        comboComponents: item.comboComponents.map((c) => ({
          productId: c.productId,
          productName: c.productName,
          quantity: c.quantity,
        })),
      })),
      deliveryFee: order.deliveryFee,
      total: order.total,
      payments: salePayments,
      tags: order.tags,
      discount: order.discount
        ? {
            campaign: order.discount.campaign,
            percent: order.discount.percent,
            amount: order.discount.amount,
          }
        : undefined,
      notes: order.notes
        ? `Encomenda #${order.code} — ${order.notes}`
        : `Encomenda #${order.code}`,
      customerId: order.customerId,
      customerName: order.customerName,
    });

    order.status = OrderStatus.ENTREGUE;
    order.deliveredAt = now;
    order.saleId = sale._id as Types.ObjectId;
    order.statusHistory.push({
      status: OrderStatus.ENTREGUE,
      at: now,
      userId: user._id as Types.ObjectId,
      userName: user.displayName,
    });
    await order.save();

    this.logger.log(
      `Encomenda #${order.code} entregue | venda: ${sale._id.toString()} | negócio: ${businessId}`,
    );
    return this.findOne(id, businessId);
  }

  /**
   * Cancela e devolve o estoque. Se a encomenda ja tinha virado venda, quem
   * devolve o estoque e o cancelamento da venda (que guarda os mesmos itens) —
   * fazer os dois restauraria em dobro.
   */
  async cancel(
    id: string,
    businessId: string,
    firebaseUid: string,
  ): Promise<Order & OrderWithTotals> {
    const order = await this.requireOrder(id, businessId);
    if (order.status === OrderStatus.CANCELADA) {
      throw new BadRequestException('Esta encomenda já foi cancelada');
    }
    const user = await this.requireUser(firebaseUid);

    if (order.saleId) {
      await this.salesService.cancelFromOrder(
        order.saleId.toString(),
        businessId,
      );
    } else {
      const delta = this.buildStockDelta(
        order.items as unknown as BuiltItem[],
      );
      for (const entry of delta.values()) entry.quantity = -entry.quantity;
      await this.applyStockDelta(
        businessId,
        user._id as Types.ObjectId,
        { _id: order._id as Types.ObjectId, code: order.code },
        delta,
        'Cancelamento de encomenda',
      );
    }

    // A campanha recupera a utilizacao. O cancelamento da venda gerada nao
    // devolve nada (ver `SalesService.cancelInternal`), entao nao ha dobra.
    await this.campaignsService.releaseUsage(businessId, order.tags);

    const now = new Date();
    order.status = OrderStatus.CANCELADA;
    order.cancelledAt = now;
    order.cancelledBy = user._id as Types.ObjectId;
    order.statusHistory.push({
      status: OrderStatus.CANCELADA,
      at: now,
      userId: user._id as Types.ObjectId,
      userName: user.displayName,
    });
    await order.save();

    this.logger.log(
      `Encomenda #${order.code} cancelada | negócio: ${businessId}`,
    );
    return this.findOne(id, businessId);
  }
}
