import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Business,
  BusinessDocument,
  UberDirectSettings,
} from '../business/schemas/business.schema';
import {
  DeliveryProvider,
  MenuOnline,
  MenuOnlineDocument,
} from '../menu/schemas/menu-online.schema';
import {
  Order,
  OrderDocument,
  OrderStatus,
  UBER_ACTIVE_STATUSES,
  UberDeliveryStatus,
} from '../orders/schemas/order.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { OrdersService } from '../orders/orders.service';
import { DeliverySettingsService } from './delivery-settings.service';
import {
  DeliveryQuote,
  DeliveryQuoteDocument,
} from './schemas/delivery-quote.schema';
import {
  UberApiError,
  UberDelivery,
  UberDirectClient,
} from './uber-direct.client';
import {
  StructuredAddress,
  UBER_STATUS_LABEL,
  cents,
  dropoffKey,
  mapCourier,
  manifestSize,
  mapDelivery,
  parseUberWebhook,
  reais,
  toE164BR,
  toUberAddress,
  verifyUberSignature,
} from './uber-direct.util';

/** Motivos que o my-store-cardapio-web-back-api traduz para o cliente. */
export type DeliveryQuoteRejection =
  | 'DELIVERY_UNAVAILABLE'
  | 'DELIVERY_DISABLED'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_MISMATCH';

const reject = (reason: string, message: string, extra?: object) =>
  new ConflictException({ statusCode: 409, reason, message, ...extra });

/** Ordem dos estados: webhook atrasado nao faz a corrida "voltar". */
const STATUS_RANK: Record<UberDeliveryStatus, number> = {
  pending: 0,
  pickup: 1,
  pickup_complete: 2,
  dropoff: 3,
  delivered: 4,
  canceled: 4,
  returned: 5,
};
const TERMINAL: UberDeliveryStatus[] = ['delivered', 'canceled', 'returned'];

/** Erros de endereco da Uber que significam "nao entregamos ai". */
const UNDELIVERABLE =
  /address_undeliverable|outside|unserviceable|no_couriers|couriers_busy/i;

/** Trava do despacho: dois cliques nao pedem dois entregadores. */
const DISPATCH_LOCK_MS = 60_000;

export interface QuoteResult {
  quoteId: string;
  fee: number;
  expiresAt: string;
  etaMinutes: number | null;
}

@Injectable()
export class UberDirectService {
  private readonly logger = new Logger(UberDirectService.name);

  constructor(
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
    @InjectModel(MenuOnline.name)
    private readonly menuModel: Model<MenuOnlineDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(DeliveryQuote.name)
    private readonly quoteModel: Model<DeliveryQuoteDocument>,
    private readonly uber: UberDirectClient,
    private readonly settings: DeliverySettingsService,
    private readonly ordersService: OrdersService,
  ) {}

  /* ======================================================================
   * Cotacao
   * ==================================================================== */

  private async quote(
    businessId: Types.ObjectId,
    uber: UberDirectSettings,
    dropoff: StructuredAddress,
    opts: { subtotal: number; dropoffPhone?: string; orderId?: Types.ObjectId },
  ): Promise<QuoteResult> {
    const creds = this.settings.credentialsOf(uber);
    if (!uber.pickupAddress) {
      throw new BadRequestException(
        'Endereço de coleta da Uber não configurado',
      );
    }
    let quote;
    try {
      quote = await this.uber.createQuote(creds, {
        pickup_address: toUberAddress(uber.pickupAddress),
        dropoff_address: toUberAddress(dropoff),
        pickup_phone_number: uber.pickupPhone,
        dropoff_phone_number: opts.dropoffPhone,
        manifest_total_value: cents(opts.subtotal),
        external_store_id: businessId.toString(),
      });
    } catch (error) {
      throw this.translate(error, 'calcular a taxa de entrega');
    }
    if (!quote?.id || typeof quote.fee !== 'number') {
      this.logger.error(
        `Cotação da Uber sem id/fee: negócio=${businessId.toString()}`,
      );
      throw new ServiceUnavailableException('Resposta inesperada da Uber');
    }
    const fee = reais(quote.fee);
    const parsed = quote.expires ? new Date(quote.expires) : null;
    // Sem `expires` (ou invalido): a Uber documenta 15 min.
    const expiresAt =
      parsed && !isNaN(parsed.getTime())
        ? parsed
        : new Date(Date.now() + 15 * 60_000);
    const etaMinutes =
      typeof quote.duration === 'number' ? Math.round(quote.duration) : null;

    await this.quoteModel.create({
      businessId,
      quoteId: quote.id,
      fee,
      expiresAt,
      dropoffKey: dropoffKey(dropoff),
      etaMinutes: etaMinutes ?? undefined,
      orderId: opts.orderId,
    });
    return {
      quoteId: quote.id,
      fee,
      expiresAt: expiresAt.toISOString(),
      etaMinutes,
    };
  }

  /** Erro da Uber -> erro HTTP nosso, sem vazar detalhes da conta. */
  private translate(error: unknown, action: string): Error {
    if (!(error instanceof UberApiError)) return error as Error;
    if (UNDELIVERABLE.test(error.code) || UNDELIVERABLE.test(error.message)) {
      return reject(
        'DELIVERY_UNAVAILABLE',
        'A Uber não está atendendo esse endereço agora.',
      );
    }
    if (error.status === 401 || error.status === 403) {
      this.logger.error(
        `Uber recusou as credenciais ao ${action}: ${error.code}`,
      );
      return new ServiceUnavailableException(
        'Credenciais da Uber Direct recusadas. Confira a configuração da loja.',
      );
    }
    if (error.status === 400 || error.status === 422) {
      return new BadRequestException(
        `A Uber recusou os dados ao ${action}: ${error.message}`,
      );
    }
    return new ServiceUnavailableException(
      `Não foi possível ${action} com a Uber agora. Tente novamente.`,
    );
  }

  /** Cotacao para o checkout do cardapio (rota interna). */
  async quoteForMenu(
    slug: string,
    address: StructuredAddress,
    subtotal: number,
  ): Promise<QuoteResult> {
    const menu = await this.menuModel
      .findOne({ slug })
      .select('businessId enabled store.delivery')
      .lean<Pick<MenuOnline, 'businessId' | 'enabled' | 'store'>>()
      .exec();
    if (!menu?.enabled) throw new NotFoundException('Cardápio não encontrado');
    const business = await this.businessModel
      .findById(menu.businessId)
      .select('config.uber')
      .lean()
      .exec();
    const delivery = menu.store?.delivery;
    const uber = business?.config?.uber;
    if (
      !business ||
      delivery?.deliveryEnabled === false ||
      delivery?.deliveryProvider !== DeliveryProvider.UBER ||
      !uber
    ) {
      throw reject('DELIVERY_DISABLED', 'Esta loja não entrega pela Uber.');
    }
    return this.quote(business._id, uber, address, {
      subtotal,
    });
  }

  /** Cotacao para o formulario de pedido do painel (a loja ja tem a Uber configurada). */
  async quoteForPanel(
    businessId: string,
    address: StructuredAddress,
    subtotal: number,
    phone?: string,
  ): Promise<QuoteResult> {
    const { business, uber } = await this.requireUber(businessId);
    return this.quote(business._id, uber, address, {
      subtotal,
      dropoffPhone: toE164BR(phone) ?? undefined,
    });
  }

  /**
   * Cotacao que o cliente viu, conferida na hora do pedido: da mesma loja,
   * para o mesmo destino e ainda dentro da validade. O frete do pedido sai
   * DAQUI, nunca do navegador.
   */
  async acceptMenuQuote(
    businessId: Types.ObjectId,
    quoteId: string,
    address: StructuredAddress,
    now = new Date(),
  ): Promise<DeliveryQuoteDocument> {
    const quote = await this.quoteModel
      .findOne({ businessId, quoteId, orderId: { $exists: false } })
      .exec();
    if (!quote || quote.dropoffKey !== dropoffKey(address)) {
      throw reject(
        'QUOTE_MISMATCH',
        'A taxa de entrega foi calculada para outro endereço. Calcule de novo.',
      );
    }
    if (quote.expiresAt.getTime() <= now.getTime()) {
      throw reject(
        'QUOTE_EXPIRED',
        'O valor da taxa de entrega expirou. Calcule de novo.',
      );
    }
    return quote;
  }

  /* ======================================================================
   * Despacho (painel)
   * ==================================================================== */

  private async requireOrder(id: string, businessId: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Encomenda não encontrada');
    const order = await this.orderModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .exec();
    if (!order) throw new NotFoundException('Encomenda não encontrada');
    if (!order.delivery) {
      throw new BadRequestException(
        'Esta encomenda não é uma entrega pela Uber',
      );
    }
    return order;
  }

  private async requireUber(businessId: string) {
    const business = await this.businessModel
      .findById(new Types.ObjectId(businessId))
      .select('name config.uber')
      .lean()
      .exec();
    const uber = business?.config?.uber;
    if (!business || !uber) {
      throw new BadRequestException(
        'Uber Direct não configurada. Preencha as credenciais na aba Loja do cardápio.',
      );
    }
    return { business, uber, creds: this.settings.credentialsOf(uber) };
  }

  private paidOf(order: OrderDocument): number {
    return (
      Math.round(
        (order.payments ?? []).reduce((s, p) => s + (p.amount ?? 0), 0) * 100,
      ) / 100
    );
  }

  private assertDispatchable(order: OrderDocument): void {
    if (
      order.status === OrderStatus.CANCELADA ||
      order.status === OrderStatus.ENTREGUE
    ) {
      throw new BadRequestException('Esta encomenda já foi encerrada');
    }
    const status = order.delivery?.status;
    if (status && UBER_ACTIVE_STATUSES.includes(status)) {
      throw new BadRequestException(
        'Já existe um entregador solicitado para este pedido',
      );
    }
    if (order.total - this.paidOf(order) > 0.009) {
      throw new BadRequestException(
        'Aguarde a confirmação do pagamento antes de solicitar a entrega',
      );
    }
  }

  /** Recota para o mesmo destino e compara com o frete que o cliente pagou. */
  async requote(id: string, businessId: string) {
    const order = await this.requireOrder(id, businessId);
    this.assertDispatchable(order);
    const { uber } = await this.requireUber(businessId);
    const delivery = order.delivery!;
    const quote = await this.quote(order.businessId, uber, delivery.dropoff, {
      subtotal: order.itemsTotal,
      dropoffPhone: delivery.recipientPhone,
      orderId: order._id,
    });
    const paidFee = delivery.quotedFee;
    return {
      ...quote,
      paidFee,
      difference: Math.round((quote.fee - paidFee) * 100) / 100,
    };
  }

  async dispatch(
    id: string,
    businessId: string,
    firebaseUid: string,
    quoteId: string,
    acceptFeeIncrease = false,
  ) {
    const order = await this.requireOrder(id, businessId);
    this.assertDispatchable(order);
    const user = await this.userModel.findOne({ firebaseUid }).exec();
    if (!user) throw new NotFoundException('Usuário não encontrado');
    const { business, uber, creds } = await this.requireUber(businessId);
    const delivery = order.delivery!;

    const quote = await this.quoteModel
      .findOne({ businessId: order.businessId, quoteId, orderId: order._id })
      .exec();
    if (!quote || quote.expiresAt.getTime() <= Date.now()) {
      throw reject(
        'QUOTE_EXPIRED',
        'A cotação expirou. Calcule a taxa de entrega de novo.',
      );
    }
    if (quote.fee - delivery.quotedFee > 0.009 && !acceptFeeIncrease) {
      throw reject(
        'FEE_INCREASED',
        `O frete subiu de R$ ${delivery.quotedFee.toFixed(2)} para R$ ${quote.fee.toFixed(2)}`,
        { fee: quote.fee, paidFee: delivery.quotedFee },
      );
    }

    // Trava: so um despacho por vez para esta encomenda.
    const now = new Date();
    const locked = await this.orderModel
      .updateOne(
        {
          _id: order._id,
          $and: [
            {
              $or: [
                { 'delivery.status': { $exists: false } },
                { 'delivery.status': { $nin: UBER_ACTIVE_STATUSES } },
              ],
            },
            {
              $or: [
                { dispatchLockedAt: { $exists: false } },
                {
                  dispatchLockedAt: {
                    $lt: new Date(now.getTime() - DISPATCH_LOCK_MS),
                  },
                },
              ],
            },
          ],
        },
        { $set: { dispatchLockedAt: now } },
      )
      .exec();
    if (!locked.modifiedCount) {
      throw new ConflictException('Esta entrega já está sendo solicitada');
    }

    const attempt =
      (delivery.events ?? []).filter((e) => e.status === 'requested').length +
      1;
    const notes = [delivery.dropoff.complement, delivery.instructions]
      .filter(Boolean)
      .join(' · ');
    // Até 10 unidades pede moto; acima, carro (ver `manifestSize`).
    const size = manifestSize(
      order.items.reduce((sum, item) => sum + item.quantity, 0),
    );
    let created: UberDelivery;
    try {
      created = await this.uber.createDelivery(creds, {
        quote_id: quoteId,
        pickup_name: business.name,
        pickup_address: toUberAddress(uber.pickupAddress!),
        pickup_phone_number: uber.pickupPhone!,
        pickup_notes: [`Pedido #${order.code}`, uber.pickupNotes]
          .filter(Boolean)
          .join(' · '),
        dropoff_name: delivery.recipientName,
        dropoff_address: toUberAddress(delivery.dropoff),
        dropoff_phone_number: delivery.recipientPhone,
        dropoff_notes: notes || undefined,
        // Entregador precisa fotografar a entrega (comprovante no app da Uber).
        dropoff_verification: { picture: true },
        manifest_items: order.items.map((item) => ({
          name: item.productName.slice(0, 100),
          quantity: item.quantity,
          size,
          price: cents(item.unitPrice),
        })),
        manifest_total_value: cents(order.itemsTotal),
        manifest_reference: `#${order.code}`,
        external_id: `${order._id.toString()}-${attempt}`,
        idempotency_key: `${order._id.toString()}-${quoteId}`,
        ...(uber.sandbox
          ? {
              test_specifications: {
                robo_courier_specification: { mode: 'auto' as const },
              },
            }
          : {}),
      });
    } catch (error) {
      await this.orderModel
        .updateOne({ _id: order._id }, { $unset: { dispatchLockedAt: 1 } })
        .exec();
      throw this.translate(error, 'solicitar o entregador');
    }

    const mapped = mapDelivery(created);
    order.delivery = {
      ...delivery,
      uberDeliveryId: created.id,
      status: mapped.status ?? 'pending',
      fee: mapped.fee ?? quote.fee,
      trackingUrl: mapped.trackingUrl,
      pickupEta: mapped.pickupEta,
      dropoffEta: mapped.dropoffEta,
      courier: mapped.courier,
      failureReason: undefined,
      requestedAt: now,
      requestedBy: user._id,
      requestedByName: user.displayName,
      events: [
        ...(delivery.events ?? []),
        { status: 'requested', at: now, source: 'operador' },
        { status: mapped.status ?? 'pending', at: now, source: 'operador' },
      ],
    };
    if (order.status !== OrderStatus.PRONTO) {
      order.status = OrderStatus.PRONTO;
      order.statusHistory.push({
        status: OrderStatus.PRONTO,
        at: now,
        userId: user._id,
        userName: user.displayName,
      });
    }
    order.dispatchLockedAt = undefined;
    order.markModified('delivery');
    await order.save();

    this.logger.log(
      `Uber solicitada: encomenda #${order.code} | corrida ${created.id} | frete ${order.delivery.fee} | negócio ${businessId}`,
    );
    return this.ordersService.findOne(id, businessId);
  }

  /** Consulta a corrida na Uber (para quando o webhook nao chegou). */
  async sync(id: string, businessId: string) {
    const order = await this.requireOrder(id, businessId);
    const deliveryId = order.delivery?.uberDeliveryId;
    if (!deliveryId)
      throw new BadRequestException('Nenhum entregador solicitado ainda');
    const { creds } = await this.requireUber(businessId);
    let remote: UberDelivery;
    try {
      remote = await this.uber.getDelivery(creds, deliveryId);
    } catch (error) {
      throw this.translate(error, 'consultar a entrega');
    }
    await this.apply(order, remote, 'sync');
    return this.ordersService.findOne(id, businessId);
  }

  async cancel(id: string, businessId: string) {
    const order = await this.requireOrder(id, businessId);
    const delivery = order.delivery!;
    if (
      !delivery.uberDeliveryId ||
      !delivery.status ||
      !UBER_ACTIVE_STATUSES.includes(delivery.status)
    ) {
      throw new BadRequestException(
        'Não há entrega em andamento para cancelar',
      );
    }
    const { creds } = await this.requireUber(businessId);
    let remote: UberDelivery;
    try {
      remote = await this.uber.cancelDelivery(creds, delivery.uberDeliveryId);
    } catch (error) {
      throw this.translate(error, 'cancelar a entrega');
    }
    await this.apply(
      order,
      { ...remote, status: remote.status || 'canceled' },
      'operador',
    );
    this.logger.log(
      `Uber cancelada pelo operador: encomenda #${order.code} | corrida ${delivery.uberDeliveryId}`,
    );
    return this.ordersService.findOne(id, businessId);
  }

  /* ======================================================================
   * Atualizacoes (webhook / sync)
   * ==================================================================== */

  /**
   * Espelha a corrida no pedido. Status so avanca (webhook fora de ordem nao
   * volta). Corrida entregue + pedido pago = encomenda entregue (vira venda).
   */
  private async apply(
    order: OrderDocument,
    remote: Partial<UberDelivery>,
    source: 'webhook' | 'sync' | 'operador',
  ): Promise<void> {
    const delivery = order.delivery!;
    const mapped = mapDelivery(remote);
    const current = delivery.status;
    const next = mapped.status;
    const advances =
      !!next &&
      next !== current &&
      (!current ||
        (!TERMINAL.includes(current) &&
          STATUS_RANK[next] >= STATUS_RANK[current]) ||
        (current === 'delivered' && next === 'returned'));

    if (advances) {
      delivery.status = next;
      delivery.events = [
        ...(delivery.events ?? []),
        { status: next, at: new Date(), source },
      ];
    }
    if (mapped.fee !== undefined) delivery.fee = mapped.fee;
    if (mapped.trackingUrl) delivery.trackingUrl = mapped.trackingUrl;
    if (mapped.pickupEta) delivery.pickupEta = mapped.pickupEta;
    if (mapped.dropoffEta) delivery.dropoffEta = mapped.dropoffEta;
    if (mapped.courier) delivery.courier = mapped.courier;
    if (mapped.failureReason) delivery.failureReason = mapped.failureReason;
    order.markModified('delivery');
    await order.save();

    if (advances) {
      this.logger.log(
        `Uber #${order.code}: ${current ?? '-'} -> ${next} (${UBER_STATUS_LABEL[next]}) via ${source}`,
      );
    }

    if (
      advances &&
      next === 'delivered' &&
      order.status !== OrderStatus.ENTREGUE &&
      order.status !== OrderStatus.CANCELADA
    ) {
      await this.autoDeliver(order);
    }
  }

  private async autoDeliver(order: OrderDocument): Promise<void> {
    const businessId = order.businessId.toString();
    if (order.total - this.paidOf(order) > 0.009) {
      // Sem pagamento registrado nao vira venda sozinha (sairia como fiado).
      this.logger.warn(
        `Uber entregou #${order.code}, mas o pagamento não foi confirmado — fica para o operador`,
      );
      return;
    }
    try {
      await this.ordersService.deliverAsUser(
        order._id.toString(),
        businessId,
        order.delivery!.requestedBy!,
        'Uber Direct',
      );
    } catch (error) {
      this.logger.error(
        `Falha ao concluir #${order.code} após entrega da Uber: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Webhook da Uber, repassado pelo my-store-cardapio-web-back-api (rota
   * interna). A assinatura da Uber e conferida com a chave da loja dona da
   * corrida — por isso o pedido e achado antes.
   */
  async handleWebhook(
    body: unknown,
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ ok: true; ignored?: string }> {
    const event = parseUberWebhook(body);
    if (!event.deliveryId) return { ok: true, ignored: 'sem delivery_id' };

    const order = await this.orderModel
      .findOne({ 'delivery.uberDeliveryId': event.deliveryId })
      .exec();
    if (!order) {
      this.logger.warn(
        `Webhook Uber de corrida desconhecida: ${event.deliveryId}`,
      );
      return { ok: true, ignored: 'corrida desconhecida' };
    }

    const business = await this.businessModel
      .findById(order.businessId)
      .select('config.uber')
      .lean()
      .exec();
    const key = this.settings.signingKeyOf(business?.config?.uber);
    if (!key || !rawBody || !verifyUberSignature(rawBody, signature, key)) {
      this.logger.warn(
        `Webhook Uber recusado (${key ? 'assinatura inválida' : 'loja sem signing key'}): #${order.code}`,
      );
      throw new UnauthorizedException('Assinatura inválida');
    }

    if (event.kind === 'event.courier_update') {
      const courier =
        mapCourier(event.delivery.courier) ?? order.delivery?.courier;
      if (courier && event.location && Number.isFinite(event.location.lat)) {
        courier.lat = event.location.lat;
        courier.lng = event.location.lng;
        courier.updatedAt = new Date();
      }
      await this.apply(
        order,
        { ...event.delivery, status: event.status, courier: undefined },
        'webhook',
      );
      if (courier) {
        await this.orderModel
          .updateOne(
            { _id: order._id },
            { $set: { 'delivery.courier': courier } },
          )
          .exec();
      }
      return { ok: true };
    }

    await this.apply(
      order,
      { ...event.delivery, status: event.status },
      'webhook',
    );
    return { ok: true };
  }
}
