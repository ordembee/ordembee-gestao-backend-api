import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Customer, CustomerDocument } from './schemas/customer.schema';
import { Sale, SaleDocument, SaleStatus } from '../sales/schemas/sale.schema';
import { PaymentMethod } from '../common/enums/payment-method.enum';
import {
  Order,
  OrderDocument,
  OrderStatus,
} from '../orders/schemas/order.schema';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

export interface CustomerWithDebt extends Customer {
  _id: Types.ObjectId;
  outstandingDebt: number;
}

export interface CustomerHistoryEntry {
  id: string;
  /** VENDA = venda identificada (PDV); ENCOMENDA = encomenda (sistema ou cardapio). */
  kind: 'VENDA' | 'ENCOMENDA';
  /** Numero da encomenda (vendas nao tem). */
  code: number | null;
  date: Date;
  deliveryAt: Date | null;
  /** false = encomenda so com o dia (sem hora). */
  hasDeliveryTime: boolean;
  channel: string | null;
  /** Origem da encomenda: INTERNO ou CARDAPIO. */
  source: string | null;
  /** SaleStatus (venda) ou OrderStatus (encomenda). */
  status: string;
  total: number;
  payments: { method: PaymentMethod; amount: number }[];
  /** Parte fiado do pedido (com a venda que a quita), se houver. */
  fiado: {
    saleId: string;
    amount: number;
    settled: boolean;
    settledAt: Date | null;
  } | null;
  items: {
    productName: string;
    quantity: number;
    subtotal: number;
    notes?: string;
  }[];
}

export interface CustomerHistorySummary {
  orderCount: number;
  totalSpent: number;
  openOrders: number;
  lastOrderAt: Date | null;
}

export interface CustomerOrderHistory {
  customer: CustomerWithDebt;
  outstandingTotal: number;
  entries: CustomerHistoryEntry[];
  nextCursor: string | null;
  summary: CustomerHistorySummary | null;
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
  ) {}

  /** Soma, por cliente, o valor em aberto das parcelas FIADO de vendas concluídas e não quitadas. */
  private async getOutstandingDebtMap(
    businessId: string,
    customerIds: Types.ObjectId[],
  ): Promise<Map<string, number>> {
    if (customerIds.length === 0) return new Map();

    const result = await this.saleModel.aggregate([
      {
        $match: {
          businessId: new Types.ObjectId(businessId),
          customerId: { $in: customerIds },
          status: SaleStatus.CONCLUIDA,
          debtSettled: false,
          'payments.method': PaymentMethod.FIADO,
        },
      },
      { $unwind: '$payments' },
      { $match: { 'payments.method': PaymentMethod.FIADO } },
      {
        $group: {
          _id: '$customerId',
          total: { $sum: '$payments.amount' },
        },
      },
    ]);

    return new Map(
      result.map((r: { _id: Types.ObjectId; total: number }) => [
        r._id.toString(),
        r.total,
      ]),
    );
  }

  private attachDebt(
    customers: CustomerDocument[],
    debtMap: Map<string, number>,
  ): CustomerWithDebt[] {
    return customers.map((c) => {
      const obj = c.toObject() as CustomerWithDebt;
      obj.outstandingDebt = debtMap.get(String(c._id)) ?? 0;
      return obj;
    });
  }

  async create(
    businessId: string,
    dto: CreateCustomerDto,
  ): Promise<CustomerDocument> {
    const customer = await this.customerModel.create({
      ...dto,
      businessId: new Types.ObjectId(businessId),
    });
    this.logger.log(
      `Cliente criado: ${customer._id.toString()} | negócio: ${businessId} | nome: "${dto.name}"`,
    );
    return customer;
  }

  async findAll(
    businessId: string,
    search?: string,
  ): Promise<CustomerWithDebt[]> {
    const filter: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
      isActive: true,
    };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    const customers = await this.customerModel
      .find(filter)
      .sort({ name: 1 })
      .exec();
    const debtMap = await this.getOutstandingDebtMap(
      businessId,
      customers.map((c) => c._id as Types.ObjectId),
    );
    return this.attachDebt(customers, debtMap);
  }

  async findOne(id: string, businessId: string): Promise<CustomerWithDebt> {
    const customer = await this.customerModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .exec();
    if (!customer) {
      this.logger.warn(
        `Cliente não encontrado: id=${id} | negócio: ${businessId}`,
      );
      throw new NotFoundException('Cliente não encontrado');
    }
    const debtMap = await this.getOutstandingDebtMap(businessId, [
      customer._id as Types.ObjectId,
    ]);
    return this.attachDebt([customer], debtMap)[0];
  }

  async update(
    id: string,
    businessId: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerDocument> {
    const filter = { _id: id, businessId: new Types.ObjectId(businessId) };
    // Endereco editado a mao: o endereco campo a campo (do cardapio) deixa de valer.
    const current =
      dto.address !== undefined
        ? await this.customerModel.findOne(filter).select('address').lean()
        : null;
    const addressChanged =
      !!current && (current.address ?? '').trim() !== dto.address!.trim();
    const customer = await this.customerModel
      .findOneAndUpdate(
        filter,
        addressChanged ? { ...dto, $unset: { addressDetails: 1 } } : dto,
        { new: true },
      )
      .exec();
    if (!customer) {
      this.logger.warn(
        `Tentativa de atualizar cliente inexistente: id=${id} | negócio: ${businessId}`,
      );
      throw new NotFoundException('Cliente não encontrado');
    }
    this.logger.log(`Cliente atualizado: ${id} | negócio: ${businessId}`);
    return customer;
  }

  async remove(id: string, businessId: string): Promise<void> {
    const customer = await this.customerModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .exec();
    if (!customer) {
      throw new NotFoundException('Cliente não encontrado');
    }

    const debtMap = await this.getOutstandingDebtMap(businessId, [
      customer._id as Types.ObjectId,
    ]);
    if ((debtMap.get(String(customer._id)) ?? 0) > 0) {
      throw new BadRequestException(
        'Não é possível remover um cliente com dívidas em aberto',
      );
    }

    customer.isActive = false;
    await customer.save();
    this.logger.log(
      `Cliente desativado (soft delete): ${id} | negócio: ${businessId}`,
    );
  }

  /**
   * Historico de pedidos identificados do cliente, do mais recente para o
   * mais antigo: vendas com o cliente (PDV, fiado...) + encomendas (inclusive
   * as do cardapio digital). A encomenda entregue gera uma venda (`orderId`):
   * ela aparece UMA vez, como encomenda, com o fiado da venda anexado.
   *
   * Paginacao por cursor: `before` = data do ultimo item da pagina anterior.
   */
  async getOrderHistory(
    id: string,
    businessId: string,
    params: { before?: string; limit?: number } = {},
  ): Promise<CustomerOrderHistory> {
    const customer = await this.findOne(id, businessId);
    const bizObjectId = new Types.ObjectId(businessId);
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const before = params.before ? new Date(params.before) : null;
    const dateFilter =
      before && !isNaN(before.getTime()) ? { createdAt: { $lt: before } } : {};

    const [sales, orders] = await Promise.all([
      this.saleModel
        .find({
          businessId: bizObjectId,
          customerId: customer._id,
          orderId: { $exists: false },
          ...dateFilter,
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean()
        .exec(),
      this.orderModel
        .find({
          businessId: bizObjectId,
          customerId: customer._id,
          ...dateFilter,
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean()
        .exec(),
    ]);

    // Venda gerada na entrega de cada encomenda — e la que fica o fiado.
    const orderSaleIds = orders
      .map((o) => o.saleId)
      .filter((id): id is Types.ObjectId => !!id);
    const orderSales = orderSaleIds.length
      ? await this.saleModel
          .find({ _id: { $in: orderSaleIds }, businessId: bizObjectId })
          .lean()
          .exec()
      : [];
    const saleById = new Map(orderSales.map((s) => [String(s._id), s]));

    const fiadoOf = (sale?: (typeof sales)[number]) => {
      if (!sale || sale.status !== SaleStatus.CONCLUIDA) return null;
      const amount = sale.payments
        .filter((p) => p.method === PaymentMethod.FIADO)
        .reduce((sum, p) => sum + p.amount, 0);
      return amount > 0
        ? {
            saleId: String(sale._id),
            amount,
            settled: !!sale.debtSettled,
            settledAt: sale.debtSettledAt ?? null,
          }
        : null;
    };
    const itemsOf = (
      items: {
        productName: string;
        quantity: number;
        subtotal: number;
        notes?: string;
      }[],
    ) =>
      items.map((i) => ({
        productName: i.productName,
        quantity: i.quantity,
        subtotal: i.subtotal,
        notes: i.notes || undefined,
      }));
    const createdAt = (doc: unknown) => (doc as { createdAt: Date }).createdAt;

    const entries: CustomerHistoryEntry[] = [
      ...sales.map((s) => ({
        id: String(s._id),
        kind: 'VENDA' as const,
        code: null,
        date: createdAt(s),
        deliveryAt: null,
        hasDeliveryTime: false,
        channel: s.channel,
        source: null,
        status: s.status,
        total: s.total,
        payments: s.payments.map((p) => ({
          method: p.method,
          amount: p.amount,
        })),
        fiado: fiadoOf(s),
        items: itemsOf(s.items),
      })),
      ...orders.map((o) => {
        const sale = o.saleId ? saleById.get(String(o.saleId)) : undefined;
        return {
          id: String(o._id),
          kind: 'ENCOMENDA' as const,
          code: o.code,
          date: createdAt(o),
          deliveryAt: o.deliveryAt,
          hasDeliveryTime: !!o.hasDeliveryTime,
          channel: null,
          source: o.source ?? 'INTERNO',
          status: o.status,
          total: o.total,
          // Entregue: o que vale e o pagamento da venda gerada (sinal + quitacao).
          payments: (sale?.payments ?? o.payments ?? []).map((p) => ({
            method: p.method,
            amount: p.amount,
          })),
          fiado: fiadoOf(sale),
          items: itemsOf(o.items),
        };
      }),
    ]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, limit);

    const hasMore = entries.length === limit;
    return {
      customer,
      outstandingTotal: customer.outstandingDebt,
      entries,
      nextCursor: hasMore
        ? entries[entries.length - 1].date.toISOString()
        : null,
      // Resumo so na primeira pagina (e o mesmo para todas).
      summary: before
        ? null
        : await this.historySummary(bizObjectId, customer._id),
    };
  }

  /** Totais do cliente: pedidos validos, quanto ja comprou e quando foi o ultimo. */
  private async historySummary(
    businessId: Types.ObjectId,
    customerId: Types.ObjectId,
  ): Promise<CustomerHistorySummary> {
    const [salesAgg, openOrders, lastSale, lastOrder] = await Promise.all([
      // Vendas concluidas (inclui as geradas por encomenda entregue).
      this.saleModel
        .aggregate<{
          count: number;
          total: number;
        }>([
          { $match: { businessId, customerId, status: SaleStatus.CONCLUIDA } },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              total: { $sum: '$total' },
            },
          },
        ])
        .exec(),
      // Encomendas ainda em andamento (ainda nao viraram venda).
      this.orderModel
        .countDocuments({
          businessId,
          customerId,
          status: {
            $in: [
              OrderStatus.PENDENTE,
              OrderStatus.EM_PRODUCAO,
              OrderStatus.PRONTO,
            ],
          },
        })
        .exec(),
      this.saleModel
        .findOne({ businessId, customerId })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean()
        .exec(),
      this.orderModel
        .findOne({ businessId, customerId })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean()
        .exec(),
    ]);
    const dates = [lastSale, lastOrder]
      .map((d) => (d ? (d as unknown as { createdAt: Date }).createdAt : null))
      .filter((d): d is Date => !!d);
    return {
      orderCount: (salesAgg[0]?.count ?? 0) + openOrders,
      totalSpent: Math.round((salesAgg[0]?.total ?? 0) * 100) / 100,
      openOrders,
      lastOrderAt: dates.length
        ? new Date(Math.max(...dates.map((d) => d.getTime())))
        : null,
    };
  }
}
