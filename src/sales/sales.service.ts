import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument, SaleStatus } from './schemas/sale.schema';
import { CreateSaleDto } from './dto/create-sale.dto';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Customer,
  CustomerDocument,
} from '../customers/schemas/customer.schema';
import { StockMovementsService } from '../stock-movements/stock-movements.service';
import { MovementType } from '../stock-movements/schemas/stock-movement.schema';
import { PricingsService } from '../pricings/pricings.service';
import { Role } from '../common/enums/role.enum';
import { PaymentMethod } from '../common/enums/payment-method.enum';
import { SaleChannel } from '../common/enums/sale-channel.enum';
import { BusinessService } from '../business/business.service';
import {
  PreparedCampaigns,
  CampaignsService,
} from '../campaigns/campaigns.service';
import {
  instantRangeFilter,
  zonedTodayRange,
} from '../common/date/timezone.util';
import {
  normalizeCampaignName,
  roundMoney,
} from '../common/campaigns/campaign.util';

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
    private readonly stockMovementsService: StockMovementsService,
    private readonly pricingsService: PricingsService,
    private readonly businessService: BusinessService,
    private readonly campaignsService: CampaignsService,
  ) {}

  /** Resolve o custo efetivo de cada produto no momento da venda: o
   * `custoFinal` em tempo real da precificação vinculada (quando houver),
   * ou o `costPrice` estático gravado no produto — mesmo critério usado por
   * `ProductsService.attachLinkedPricing`. Precisa ser recalculado aqui (não
   * basta ler `product.costPrice` puro) porque produtos vinculados a uma
   * precificação nunca têm esse campo persistido/atualizado no banco. */
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

  async create(
    firebaseUid: string,
    businessId: string,
    dto: CreateSaleDto,
  ): Promise<SaleDocument> {
    const user = await this.userModel.findOne({ firebaseUid }).exec();
    if (!user) {
      this.logger.warn(
        `Usuário não encontrado ao criar venda: firebaseUid=${firebaseUid}`,
      );
      throw new NotFoundException('Usuário não encontrado');
    }

    const hasFiado = dto.payments.some((p) => p.method === PaymentMethod.FIADO);
    if (hasFiado && !dto.customerId) {
      throw new BadRequestException('Cliente é obrigatório para venda fiado');
    }

    let customer: CustomerDocument | null = null;
    if (dto.customerId) {
      customer = await this.customerModel
        .findOne({
          _id: dto.customerId,
          businessId: new Types.ObjectId(businessId),
          isActive: true,
        })
        .exec();
      if (!customer) {
        throw new NotFoundException('Cliente não encontrado');
      }
    }

    const rawItems = dto.items.map((item) => ({
      ...item,
      productId: new Types.ObjectId(item.productId),
    }));

    const productIds = rawItems.map((item) => item.productId);
    const products = await this.productModel
      .find({ _id: { $in: productIds } })
      .select('costPrice pricingId stock name isCombo comboItems')
      .exec();

    const productMap = new Map<string, ProductDocument>(
      products.map((p) => [String(p._id), p]),
    );
    const costPriceMap = await this.resolveCostPrices(businessId, products);

    // Coleta IDs dos componentes de combos para buscar seus estoques
    const componentIds: Types.ObjectId[] = [];
    for (const p of products) {
      if (p.isCombo && p.comboItems?.length > 0) {
        componentIds.push(...p.comboItems.map((ci) => ci.productId));
      }
    }
    if (componentIds.length > 0) {
      const componentProducts = await this.productModel
        .find({ _id: { $in: componentIds } })
        .select('stock name')
        .exec();
      for (const cp of componentProducts) {
        productMap.set(String(cp._id), cp);
      }
    }

    const items = rawItems.map((item) => {
      const p = productMap.get(String(item.productId));
      const costPrice: number = costPriceMap.get(String(item.productId)) ?? 0;
      const profit: number = (item.unitPrice - costPrice) * item.quantity;
      const comboComponents = p?.isCombo
        ? (p.comboItems ?? []).map((ci) => ({
            productId: ci.productId,
            productName: ci.productName,
            quantity: ci.quantity,
          }))
        : [];
      return { ...item, costPrice, profit, comboComponents };
    });

    const itemsTotal = roundMoney(
      items.reduce((sum, item) => sum + item.subtotal, 0),
    );

    // A campaign digitada no caixa ("#natal 2025") vira NATAL2025, consome uma
    // utilizacao da campanha e devolve o desconto que ela concede — ver
    // `CampaignsService.prepareForDocument`.
    const preparedTags = await this.campaignsService.prepareForDocument(
      businessId,
      dto.tags,
      itemsTotal,
    );
    const { tags, discount } = preparedTags;

    const total = roundMoney(itemsTotal - (discount?.amount ?? 0));

    // O caixa manda o total que mostrou ao cliente. Se ele nao bate com o que
    // o servidor calculou (tela desatualizada, desconto forjado), a venda nao
    // passa: o extrato de pagamentos fecharia com um valor que ninguem cobrou.
    if (Math.abs(dto.total - total) > 0.01) {
      throw new BadRequestException(
        `O total enviado (R$ ${dto.total.toFixed(2)}) não confere com o calculado (R$ ${total.toFixed(2)}). Atualize a tela e refaça a venda.`,
      );
    }

    // O desconto sai do lucro: os itens continuam com o preco cheio.
    const totalProfit = roundMoney(
      items.reduce((sum, item) => sum + item.profit, 0) -
        (discount?.amount ?? 0),
    );

    const sale = await this.saleModel.create({
      ...dto,
      items,
      tags,
      discount: discount ?? undefined,
      total,
      totalProfit,
      businessId: new Types.ObjectId(businessId),
      userId: user._id,
      customerId: customer?._id,
      customerName: customer?.name,
    });

    // So agora a campanha consome utilizacao: a venda ja passou por todas as
    // validacoes e existe no banco.
    await this.campaignsService.commitUsage(businessId, preparedTags);

    // Monta mapa de decrementos: produtos regulares decrementam a si mesmos,
    // combos decrementam seus componentes (qtd combo × qtd item vendido)
    const decrementMap = new Map<
      string,
      { productId: Types.ObjectId; quantity: number }
    >();
    for (const item of items) {
      const prod = productMap.get(String(item.productId));
      if (prod?.isCombo && item.comboComponents?.length > 0) {
        for (const ci of item.comboComponents) {
          const key = String(ci.productId);
          const existing = decrementMap.get(key);
          if (existing) {
            existing.quantity += ci.quantity * item.quantity;
          } else {
            decrementMap.set(key, {
              productId: ci.productId,
              quantity: ci.quantity * item.quantity,
            });
          }
        }
      } else {
        const key = String(item.productId);
        const existing = decrementMap.get(key);
        if (existing) {
          existing.quantity += item.quantity;
        } else {
          decrementMap.set(key, {
            productId: item.productId,
            quantity: item.quantity,
          });
        }
      }
    }

    await this.productModel.bulkWrite(
      Array.from(decrementMap.values()).map(({ productId, quantity }) => ({
        updateOne: {
          filter: {
            _id: productId,
            businessId: new Types.ObjectId(businessId),
            stock: { $gte: 0 },
          },
          update: { $inc: { stock: -quantity } },
        },
      })),
    );

    // Grava histórico de movimentação para cada produto decrementado com estoque controlado
    await Promise.all(
      Array.from(decrementMap.entries()).map(
        ([key, { productId, quantity }]) => {
          const prod = productMap.get(key);
          const previousStock = prod?.stock ?? -1;
          if (previousStock < 0) return Promise.resolve();
          const newStock = Math.max(0, previousStock - quantity);
          return this.stockMovementsService.recordSaleMovement(
            {
              productId,
              productName: prod?.name ?? '',
              businessId: new Types.ObjectId(businessId),
              userId: user._id as Types.ObjectId,
              type: MovementType.VENDA,
              quantity,
              reason: `Venda #${sale._id.toString()}`,
              saleId: sale._id as Types.ObjectId,
            },
            previousStock,
            newStock,
          );
        },
      ),
    );

    this.logger.log(
      `Venda criada: ${sale._id.toString()} | negócio: ${businessId} | total: ${sale.total} | canal: ${sale.channel}`,
    );
    return sale;
  }

  /**
   * Cria a venda correspondente a uma encomenda ENTREGUE.
   *
   * Diferente de `create()`, NAO mexe em estoque: os itens ja foram baixados
   * quando a encomenda foi aceita (ver `OrdersService.create`). A venda entra
   * no caixa do dia da entrega, com o total cheio (itens + taxa) e o extrato
   * completo de pagamentos (sinal + quitacao).
   */
  async createFromOrder(params: {
    businessId: string;
    userId: Types.ObjectId;
    orderId: Types.ObjectId;
    orderSource: 'INTERNO' | 'CARDAPIO';
    items: {
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
    }[];
    deliveryFee: number;
    total: number;
    payments: { method: PaymentMethod; amount: number }[];
    tags: string[];
    /** Desconto ja concedido na encomenda — a venda so o espelha. */
    discount?: { campaign: string; percent: number; amount: number };
    notes?: string;
    customerId?: Types.ObjectId;
    customerName?: string;
  }): Promise<SaleDocument> {
    const totalProfit = roundMoney(
      params.items.reduce((sum, item) => sum + item.profit, 0) -
        (params.discount?.amount ?? 0),
    );

    const sale = await this.saleModel.create({
      items: params.items,
      total: params.total,
      discount: params.discount,
      deliveryFee: params.deliveryFee,
      channel: SaleChannel.ENCOMENDA,
      payments: params.payments,
      status: SaleStatus.CONCLUIDA,
      businessId: new Types.ObjectId(params.businessId),
      userId: params.userId,
      orderId: params.orderId,
      orderSource: params.orderSource,
      tags: params.tags,
      totalProfit,
      notes: params.notes,
      customerId: params.customerId,
      customerName: params.customerName,
    });

    this.logger.log(
      `Venda de encomenda criada: ${sale._id.toString()} | encomenda: ${params.orderId.toString()} | total: ${sale.total}`,
    );
    return sale;
  }

  async findAll(
    businessId: string,
    _role: string,
    params: {
      page: number;
      limit: number;
      status?: string;
      dateFrom?: string;
      dateTo?: string;
      operatorId?: string;
      campaign?: string;
    },
  ): Promise<{ data: SaleDocument[]; total: number; totalPages: number }> {
    const { page, limit, status, dateFrom, dateTo, operatorId, campaign } =
      params;
    const filter: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
    };

    // Limites resolvidos no fuso do negócio (robusto a instante deslocado ou 'YYYY-MM-DD').
    const tz = await this.businessService.getTimezone(businessId);
    const dateFilter = instantRangeFilter(dateFrom, dateTo, tz);
    if (dateFilter) filter.createdAt = dateFilter;

    if (status) filter.status = status;
    if (operatorId) filter.userId = new Types.ObjectId(operatorId);
    if (campaign) {
      const normalized = normalizeCampaignName(campaign);
      if (normalized) filter.tags = normalized;
    }

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.saleModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'displayName email')
        .exec(),
      this.saleModel.countDocuments(filter).exec(),
    ]);

    return { data, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async findOne(id: string, businessId: string): Promise<SaleDocument> {
    const sale = await this.saleModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .populate('userId', 'displayName email')
      .exec();
    if (!sale) {
      this.logger.warn(
        `Venda não encontrada: id=${id} | negócio: ${businessId}`,
      );
      throw new NotFoundException('Venda não encontrada');
    }
    return sale;
  }

  /**
   * Cancelamento pedido pela tela de Vendas. Uma venda que nasceu de uma
   * encomenda nao pode ser cancelada por aqui: quem controla o estoque desses
   * itens e a encomenda (o estoque foi baixado la, na criacao), entao cancelar
   * pelos dois lados restauraria o estoque duas vezes. O caminho e cancelar a
   * encomenda, que por sua vez chama `cancelFromOrder`.
   */
  async cancel(id: string, businessId: string): Promise<SaleDocument> {
    const existing = await this.saleModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .select('orderId')
      .exec();
    if (existing?.orderId) {
      throw new BadRequestException(
        'Esta venda veio de uma encomenda. Cancele a encomenda para desfazer a venda e devolver o estoque.',
      );
    }
    return this.cancelInternal(id, businessId);
  }

  /** Cancelamento disparado pelo modulo de encomendas (sem a guarda acima). */
  async cancelFromOrder(id: string, businessId: string): Promise<SaleDocument> {
    return this.cancelInternal(id, businessId);
  }

  private async cancelInternal(
    id: string,
    businessId: string,
  ): Promise<SaleDocument> {
    const sale = await this.saleModel
      .findOneAndUpdate(
        {
          _id: id,
          businessId: new Types.ObjectId(businessId),
          status: { $ne: SaleStatus.CANCELADA },
        },
        { status: SaleStatus.CANCELADA },
        { new: true },
      )
      .exec();
    if (!sale) {
      this.logger.warn(
        `Tentativa de cancelar venda inexistente ou já cancelada: id=${id} | negócio: ${businessId}`,
      );
      throw new NotFoundException('Venda não encontrada');
    }

    // Venda cancelada devolve a utilizacao da campanha. Quando a venda veio de
    // uma encomenda quem devolve e o cancelamento da encomenda (que guarda as
    // mesmas tags) — fazer os dois devolveria em dobro.
    if (!sale.orderId) {
      await this.campaignsService.releaseUsage(businessId, sale.tags);
    }

    // Restaura estoque e grava histórico
    // Expande combos usando comboComponents gravados no momento da venda
    const restoreMap = new Map<
      string,
      { productId: Types.ObjectId; productName: string; quantity: number }
    >();
    for (const item of sale.items) {
      if (item.comboComponents?.length > 0) {
        for (const ci of item.comboComponents) {
          const key = String(ci.productId);
          const existing = restoreMap.get(key);
          if (existing) {
            existing.quantity += ci.quantity * item.quantity;
          } else {
            restoreMap.set(key, {
              productId: ci.productId,
              productName: ci.productName,
              quantity: ci.quantity * item.quantity,
            });
          }
        }
      } else {
        const key = String(item.productId);
        const existing = restoreMap.get(key);
        if (existing) {
          existing.quantity += item.quantity;
        } else {
          restoreMap.set(key, {
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
          });
        }
      }
    }

    const restoreIds = Array.from(restoreMap.values()).map((r) => r.productId);
    const products = await this.productModel
      .find({
        _id: { $in: restoreIds },
        businessId: new Types.ObjectId(businessId),
        stock: { $gte: 0 },
      })
      .select('stock name')
      .exec();
    const stockMap = new Map(products.map((p) => [String(p._id), p]));

    if (products.length > 0) {
      await this.productModel.bulkWrite(
        Array.from(restoreMap.values())
          .filter(({ productId }) => stockMap.has(String(productId)))
          .map(({ productId, quantity }) => ({
            updateOne: {
              filter: {
                _id: productId,
                businessId: new Types.ObjectId(businessId),
              },
              update: { $inc: { stock: quantity } },
            },
          })),
      );

      await Promise.all(
        Array.from(restoreMap.values()).map(
          ({ productId, productName, quantity }) => {
            const prod = stockMap.get(String(productId));
            if (!prod) return Promise.resolve();
            const previousStock = prod.stock;
            const newStock = previousStock + quantity;
            return this.stockMovementsService.recordSaleMovement(
              {
                productId,
                productName,
                businessId: new Types.ObjectId(businessId),
                userId: sale.userId as Types.ObjectId,
                type: MovementType.CANCELAMENTO,
                quantity,
                reason: `Cancelamento venda #${id}`,
                saleId: sale._id as Types.ObjectId,
              },
              previousStock,
              newStock,
            );
          },
        ),
      );
    }

    this.logger.log(`Venda cancelada: ${id} | negócio: ${businessId}`);
    return sale;
  }

  async updatePayments(
    id: string,
    businessId: string,
    payments: { method: PaymentMethod; amount: number }[],
  ): Promise<SaleDocument> {
    const sale = await this.saleModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .exec();
    if (!sale) {
      throw new NotFoundException('Venda não encontrada');
    }
    if (sale.status === SaleStatus.CANCELADA) {
      throw new BadRequestException(
        'Não é possível alterar a forma de pagamento de uma venda cancelada',
      );
    }

    const sum = payments.reduce((s, p) => s + p.amount, 0);
    if (Math.abs(sum - sale.total) > 0.01) {
      throw new BadRequestException(
        'A soma dos pagamentos deve ser igual ao total da venda',
      );
    }

    sale.payments = payments as SaleDocument['payments'];
    await sale.save();

    this.logger.log(
      `Forma de pagamento atualizada: ${id} | negócio: ${businessId}`,
    );
    return this.findOne(id, businessId);
  }

  async settleDebt(
    id: string,
    businessId: string,
    firebaseUid: string,
  ): Promise<SaleDocument> {
    const user = await this.userModel.findOne({ firebaseUid }).exec();
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const sale = await this.saleModel
      .findOneAndUpdate(
        {
          _id: id,
          businessId: new Types.ObjectId(businessId),
          debtSettled: false,
          'payments.method': PaymentMethod.FIADO,
        },
        {
          debtSettled: true,
          debtSettledAt: new Date(),
          debtSettledBy: user._id,
        },
        { new: true },
      )
      .exec();
    if (!sale) {
      this.logger.warn(
        `Tentativa de quitar dívida inexistente ou já quitada: id=${id} | negócio: ${businessId}`,
      );
      throw new NotFoundException('Venda não encontrada ou dívida já quitada');
    }

    this.logger.log(`Dívida quitada: ${id} | negócio: ${businessId}`);
    return sale;
  }

  async getDaySummary(businessId: string): Promise<{
    total: number;
    count: number;
    byChannel: Record<string, number>;
  }> {
    const tz = await this.businessService.getTimezone(businessId);
    const { start, end } = zonedTodayRange(tz);

    const sales = await this.saleModel
      .find({
        businessId: new Types.ObjectId(businessId),
        status: SaleStatus.CONCLUIDA,
        createdAt: { $gte: start, $lte: end },
      })
      .exec();

    const byChannel: Record<string, number> = {};
    let total = 0;

    for (const sale of sales) {
      total += sale.total;
      byChannel[sale.channel] = (byChannel[sale.channel] || 0) + sale.total;
    }

    return { total, count: sales.length, byChannel };
  }

  async getOperatorCashClose(
    firebaseUid: string,
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
    targetUserId?: string,
    requesterRole?: Role,
  ): Promise<{
    operatorName: string;
    totalSales: number;
    totalItems: number;
    grandTotal: number;
    byChannel: {
      channel: string;
      total: number;
      count: number;
      byPaymentMethod: {
        paymentMethod: string;
        total: number;
        count: number;
      }[];
    }[];
  }> {
    const user = await this.userModel.findOne({ firebaseUid }).exec();
    if (!user) throw new NotFoundException('Usuário não encontrado');

    // OWNER/GERENTE sem operador selecionado = fechamento consolidado de todos
    // os operadores. CAIXA nunca envia targetUserId — sempre restrito a si mesmo.
    const isPrivileged =
      requesterRole === Role.OWNER || requesterRole === Role.GERENTE;
    const aggregateAll = isPrivileged && !targetUserId;

    const resolvedUserId = aggregateAll
      ? undefined
      : targetUserId
        ? new Types.ObjectId(targetUserId)
        : user._id;

    const targetUser = targetUserId
      ? await this.userModel.findById(resolvedUserId).exec()
      : user;

    const match: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
      status: SaleStatus.CONCLUIDA,
    };
    if (resolvedUserId) match.userId = resolvedUserId;

    const tz = await this.businessService.getTimezone(businessId);
    const dateFilter = instantRangeFilter(dateFrom, dateTo, tz);
    if (dateFilter) match.createdAt = dateFilter;

    const result = await this.saleModel.aggregate([
      { $match: match },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalSales: { $sum: 1 },
                grandTotal: { $sum: '$total' },
                totalItems: { $sum: { $sum: '$items.quantity' } },
              },
            },
          ],
          byChannelBase: [
            {
              $group: {
                _id: '$channel',
                total: { $sum: '$total' },
                count: { $sum: 1 },
              },
            },
          ],
          byChannelPayments: [
            { $unwind: '$payments' },
            {
              $group: {
                _id: { channel: '$channel', method: '$payments.method' },
                pmTotal: { $sum: '$payments.amount' },
                pmCount: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const raw = result[0] as {
      summary: { totalSales: number; grandTotal: number; totalItems: number }[];
      byChannelBase: { _id: string; total: number; count: number }[];
      byChannelPayments: {
        _id: { channel: string; method: string };
        pmTotal: number;
        pmCount: number;
      }[];
    };
    const summary = raw.summary[0] ?? {
      totalSales: 0,
      grandTotal: 0,
      totalItems: 0,
    };

    const channelMap = new Map<
      string,
      {
        channel: string;
        total: number;
        count: number;
        byPaymentMethod: {
          paymentMethod: string;
          total: number;
          count: number;
        }[];
      }
    >();
    for (const c of raw.byChannelBase) {
      channelMap.set(c._id, {
        channel: c._id,
        total: c.total,
        count: c.count,
        byPaymentMethod: [],
      });
    }
    for (const cp of raw.byChannelPayments) {
      const entry = channelMap.get(cp._id.channel);
      if (entry)
        entry.byPaymentMethod.push({
          paymentMethod: cp._id.method,
          total: cp.pmTotal,
          count: cp.pmCount,
        });
    }
    const byChannel = Array.from(channelMap.values())
      .sort((a, b) => b.total - a.total)
      .map((c) => ({
        ...c,
        byPaymentMethod: c.byPaymentMethod.sort((a, b) => b.total - a.total),
      }));

    return {
      operatorName: aggregateAll
        ? 'Todos os operadores'
        : targetUser?.displayName ||
          targetUser?.email ||
          user.displayName ||
          user.email,
      totalSales: summary.totalSales,
      totalItems: summary.totalItems,
      grandTotal: summary.grandTotal,
      byChannel,
    };
  }

  async getCashClose(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<{
    totalRevenue: number;
    totalProfit: number;
    count: number;
    byChannel: { channel: string; total: number; count: number }[];
    byPaymentMethod: { paymentMethod: string; total: number; count: number }[];
    byOperator: {
      operatorId: string;
      displayName: string;
      total: number;
      count: number;
      byPaymentMethod: { paymentMethod: string; total: number }[];
    }[];
  }> {
    const match: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
      status: SaleStatus.CONCLUIDA,
    };

    const tz = await this.businessService.getTimezone(businessId);
    const dateFilter = instantRangeFilter(dateFrom, dateTo, tz);
    if (dateFilter) match.createdAt = dateFilter;

    const result = await this.saleModel.aggregate([
      { $match: match },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: '$total' },
                totalProfit: { $sum: '$totalProfit' },
                count: { $sum: 1 },
              },
            },
          ],
          byChannel: [
            {
              $group: {
                _id: '$channel',
                total: { $sum: '$total' },
                count: { $sum: 1 },
              },
            },
            { $sort: { total: -1 } },
          ],
          byPaymentMethod: [
            { $unwind: '$payments' },
            {
              $group: {
                _id: '$payments.method',
                total: { $sum: '$payments.amount' },
                count: { $sum: 1 },
              },
            },
            { $sort: { total: -1 } },
          ],
          byOperatorBase: [
            {
              $lookup: {
                from: 'users',
                localField: 'userId',
                foreignField: '_id',
                as: 'user',
              },
            },
            {
              $group: {
                _id: '$userId',
                displayName: {
                  $first: { $arrayElemAt: ['$user.displayName', 0] },
                },
                email: { $first: { $arrayElemAt: ['$user.email', 0] } },
                total: { $sum: '$total' },
                count: { $sum: 1 },
              },
            },
            { $sort: { total: -1 } },
          ],
          byOperatorPayments: [
            { $unwind: '$payments' },
            {
              $group: {
                _id: { userId: '$userId', method: '$payments.method' },
                total: { $sum: '$payments.amount' },
              },
            },
          ],
        },
      },
    ]);

    const raw = result[0] as {
      summary: { totalRevenue: number; totalProfit: number; count: number }[];
      byChannel: { _id: string; total: number; count: number }[];
      byPaymentMethod: { _id: string; total: number; count: number }[];
      byOperatorBase: {
        _id: Types.ObjectId;
        displayName: string;
        email: string;
        total: number;
        count: number;
      }[];
      byOperatorPayments: {
        _id: { userId: Types.ObjectId; method: string };
        total: number;
      }[];
    };

    const summary = raw.summary[0] ?? {
      totalRevenue: 0,
      totalProfit: 0,
      count: 0,
    };

    const operatorPaymentsMap = new Map<
      string,
      { paymentMethod: string; total: number }[]
    >();
    for (const op of raw.byOperatorPayments) {
      const key = op._id.userId.toString();
      if (!operatorPaymentsMap.has(key)) operatorPaymentsMap.set(key, []);
      operatorPaymentsMap
        .get(key)!
        .push({ paymentMethod: op._id.method, total: op.total });
    }

    return {
      totalRevenue: summary.totalRevenue,
      totalProfit: summary.totalProfit,
      count: summary.count,
      byChannel: raw.byChannel.map((c) => ({
        channel: c._id,
        total: c.total,
        count: c.count,
      })),
      byPaymentMethod: raw.byPaymentMethod.map((p) => ({
        paymentMethod: p._id,
        total: p.total,
        count: p.count,
      })),
      byOperator: raw.byOperatorBase.map((o) => ({
        operatorId: o._id?.toString() ?? '',
        displayName: o.displayName || o.email || 'Desconhecido',
        total: o.total,
        count: o.count,
        byPaymentMethod: (
          operatorPaymentsMap.get(o._id?.toString() ?? '') ?? []
        ).sort((a, b) => b.total - a.total),
      })),
    };
  }

  /**
   * Atualiza uma venda completa (data, canal, itens, pagamentos).
   *
   * Validações:
   * - Venda não pode estar CANCELADA
   * - createdAt não pode ser futuro
   * - sum(payments.amount) DEVE === total (recalculado)
   * - Gera StockMovement tipo 'ajuste' se quantidade mudar
   *
   * @param id ID da venda
   * @param businessId ID do negócio
   * @param firebaseUid Firebase UID do usuário que está fazendo a edição
   * @param userId MongoDB ObjectId do usuário (para performanceOptimization)
   * @param dto Dados a atualizar
   * @returns Sale atualizada
   */
  async update(
    id: string,
    businessId: string,
    firebaseUid: string,
    userId: Types.ObjectId | string,
    dto: any, // UpdateSaleDto
  ): Promise<SaleDocument> {
    const sale = await this.saleModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .exec();

    if (!sale) {
      this.logger.warn(
        `Tentativa de atualizar venda inexistente: id=${id} | negócio: ${businessId}`,
      );
      throw new NotFoundException('Venda não encontrada');
    }

    if (sale.status === SaleStatus.CANCELADA) {
      throw new BadRequestException(
        'Não é possível editar uma venda cancelada',
      );
    }

    // Validar createdAt se fornecido (será aplicado ao final com $set)
    let newCreatedAt: Date | null = null;
    if (dto.createdAt) {
      const newDate = new Date(dto.createdAt);
      if (isNaN(newDate.getTime())) {
        throw new BadRequestException('Data inválida');
      }
      if (newDate > new Date()) {
        throw new BadRequestException('A data da venda não pode ser no futuro');
      }
      newCreatedAt = newDate;
    }

    // Atualizar canal se fornecido
    if (dto.channel !== undefined) {
      sale.channel = dto.channel;
    }

    // Atualizar notas se fornecidas
    if (dto.notes !== undefined) {
      sale.notes = dto.notes;
    }

    // Os itens de uma venda de encomenda sao espelho da encomenda (que e quem
    // baixou o estoque) — editar por aqui deixaria os dois fora de sincronia.
    if (dto.items && sale.orderId) {
      throw new BadRequestException(
        'Os itens desta venda vieram de uma encomenda. Edite a encomenda para alterá-los.',
      );
    }

    // ===== Processar atualização de itens =====
    if (dto.items && dto.items.length > 0) {
      // Buscar produtos para validação e cálculo de custos
      const productIds = dto.items.map(
        (item) => new Types.ObjectId(item.productId),
      );
      const products = await this.productModel
        .find({ _id: { $in: productIds } })
        .select('costPrice pricingId stock name isCombo comboItems')
        .exec();

      const productMap = new Map<string, ProductDocument>(
        products.map((p) => [String(p._id), p]),
      );

      if (products.length !== dto.items.length) {
        throw new BadRequestException(
          'Um ou mais produtos não foram encontrados',
        );
      }

      const costPriceMap = await this.resolveCostPrices(businessId, products);

      // Mapa de quantidades antigas para cálculo de ajustes
      const oldQtyMap = new Map<string, number>(
        sale.items.map((item) => [String(item.productId), item.quantity]),
      );

      // Recalcular itens com novos preços e quantidades
      const newItems = dto.items.map((item) => {
        const p = productMap.get(item.productId);
        if (!p) {
          throw new BadRequestException(
            `Produto ${item.productId} não encontrado`,
          );
        }

        const costPrice: number = costPriceMap.get(item.productId) ?? 0;
        const subtotal = item.unitPrice * item.quantity;
        const profit: number = (item.unitPrice - costPrice) * item.quantity;

        // Recuperar comboComponents do item antigo (se existir)
        const oldItem = sale.items.find(
          (si) => String(si.productId) === item.productId,
        );
        const comboComponents = oldItem?.comboComponents ?? [];

        return {
          productId: new Types.ObjectId(item.productId),
          productName: p.name,
          unitPrice: item.unitPrice,
          costPrice,
          quantity: item.quantity,
          subtotal,
          profit,
          comboComponents,
        };
      });

      sale.items = newItems as SaleDocument['items'];

      // ===== Gerar StockMovements para ajustes de quantidade =====
      const user = await this.userModel.findOne({ firebaseUid }).exec();
      const adjustments: Array<{
        productId: Types.ObjectId;
        productName: string;
        oldQty: number;
        newQty: number;
      }> = [];

      for (const newItem of newItems) {
        const oldQty = oldQtyMap.get(String(newItem.productId)) ?? 0;
        if (oldQty !== newItem.quantity) {
          const product = productMap.get(String(newItem.productId));
          adjustments.push({
            productId: newItem.productId,
            productName: product?.name ?? newItem.productName,
            oldQty,
            newQty: newItem.quantity,
          });
        }
      }

      // Aplicar ajustes de estoque
      if (adjustments.length > 0 && user) {
        for (const adj of adjustments) {
          const delta = adj.newQty - adj.oldQty;
          const oldProduct = await this.productModel
            .findById(adj.productId)
            .select('stock')
            .exec();

          if (oldProduct && oldProduct.stock >= 0) {
            const previousStock = oldProduct.stock;
            const newStock = Math.max(0, previousStock - delta);

            await this.productModel.updateOne(
              { _id: adj.productId },
              { $set: { stock: newStock } },
            );

            // Registrar movimento de ajuste
            await this.stockMovementsService.recordSaleMovement(
              {
                productId: adj.productId,
                productName: adj.productName,
                businessId: new Types.ObjectId(businessId),
                userId: user._id as Types.ObjectId,
                type: MovementType.AJUSTE,
                quantity: Math.abs(delta),
                reason: `Ajuste venda #${id} (${adj.oldQty} → ${adj.newQty})`,
                saleId: sale._id as Types.ObjectId,
              },
              previousStock,
              newStock,
            );
          }
        }
      }
    }

    // ===== Tags, desconto e totais =====
    // Vem depois dos itens porque o desconto e percentual sobre o subtotal.
    let discountCleared = false;
    let preparedTags: PreparedCampaigns | null = null;
    if (dto.items || dto.tags !== undefined) {
      const itemsTotal = roundMoney(
        sale.items.reduce((sum, item) => sum + item.subtotal, 0),
      );

      if (dto.tags !== undefined) {
        // As tags que ja estavam na venda nao sao revalidadas: uma campanha
        // que acabou ontem nao pode travar a correcao de uma venda de antes.
        preparedTags = await this.campaignsService.prepareForDocument(
          businessId,
          dto.tags,
          itemsTotal,
          sale.tags ?? [],
        );
        sale.tags = preparedTags.tags;
        discountCleared = !preparedTags.discount && !!sale.discount;
        sale.discount = preparedTags.discount
          ? (preparedTags.discount as SaleDocument['discount'])
          : undefined;
      } else if (sale.discount) {
        // So os itens mudaram: o percentual continua, o valor acompanha.
        sale.discount.amount = roundMoney(
          (itemsTotal * sale.discount.percent) / 100,
        );
      }

      // A taxa de entrega nao vem dos itens, entao precisa ser somada de volta
      // — senao editar a venda a apagaria. O desconto incide so nos itens.
      sale.total = roundMoney(
        itemsTotal + (sale.deliveryFee ?? 0) - (sale.discount?.amount ?? 0),
      );
      sale.totalProfit = roundMoney(
        sale.items.reduce((sum, item) => sum + item.profit, 0) -
          (sale.discount?.amount ?? 0),
      );
    }

    // ===== Processar atualização de pagamentos =====
    if (dto.payments && dto.payments.length > 0) {
      const paymentsSum = dto.payments.reduce((sum, p) => sum + p.amount, 0);

      // Validar soma de pagamentos contra o novo total
      if (Math.abs(paymentsSum - sale.total) > 0.01) {
        throw new BadRequestException(
          'A soma dos pagamentos deve ser igual ao total da venda (R$ ' +
            sale.total.toFixed(2) +
            ')',
        );
      }

      sale.payments = dto.payments as SaleDocument['payments'];
    } else if (dto.items) {
      // Se apenas itens foram atualizados, validar pagamentos existentes contra novo total
      const paymentsSum = sale.payments.reduce((sum, p) => sum + p.amount, 0);
      if (Math.abs(paymentsSum - sale.total) > 0.01) {
        throw new BadRequestException(
          'A soma dos pagamentos existentes não corresponde ao novo total da venda. ' +
            'Forneça novo array de pagamentos.',
        );
      }
    }

    // Salvar venda atualizada
    const updateData: Record<string, unknown> = {
      channel: sale.channel,
      items: sale.items,
      total: sale.total,
      totalProfit: sale.totalProfit,
      payments: sale.payments,
      tags: sale.tags,
    };

    if (sale.discount) {
      updateData.discount = sale.discount;
    }

    if (sale.notes !== undefined) {
      updateData.notes = sale.notes;
    }

    if (newCreatedAt) {
      updateData.createdAt = newCreatedAt;
    }

    await this.saleModel
      .findByIdAndUpdate(sale._id, {
        $set: updateData,
        // Tirar a ultima campaign com desconto tem que apagar o campo, nao deixar
        // o valor antigo para tras.
        ...(discountCleared ? { $unset: { discount: '' } } : {}),
      })
      .exec();

    if (preparedTags) {
      await this.campaignsService.commitUsage(businessId, preparedTags);
    }

    this.logger.log(
      `Venda atualizada: ${id} | negócio: ${businessId} | novo total: ${sale.total}`,
    );

    return this.findOne(id, businessId);
  }
}
