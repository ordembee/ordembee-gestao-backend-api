import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Business,
  BusinessDocument,
  InfinitePaySettings,
} from '../business/schemas/business.schema';
import {
  MenuOnline,
  MenuOnlineDocument,
} from '../menu/schemas/menu-online.schema';
import {
  Order,
  OrderDocument,
  OrderPaymentKind,
  OrderStatus,
} from '../orders/schemas/order.schema';
import { PaymentMethod } from '../common/enums/payment-method.enum';
import {
  InfinitePayApiError,
  InfinitePayCheckResponse,
  InfinitePayClient,
} from './infinitepay.client';
import {
  buildLinkItems,
  describeOrderLine,
  fromCents,
  INFINITEPAY_HANDLE,
  methodOfCapture,
  normalizeHandle,
  parseLinkUrl,
  sumCents,
  toCents,
  INFINITEPAY_MIN_CENTS,
  toLinkAddress,
} from './infinitepay.util';
import {
  InfinitePayWebhookPayload,
  UpdateInfinitePaySettingsDto,
} from './dto/infinitepay.dto';

/** A loja so cobra pela InfinitePay com a integracao ligada e a InfiniteTag preenchida. */
export function infinitePayActive(
  cfg: InfinitePaySettings | undefined,
): cfg is InfinitePaySettings {
  return !!cfg?.enabled && !!cfg.handle;
}

export type { InfinitePayWebhookPayload } from './dto/infinitepay.dto';

export interface InfinitePayPaymentStatus {
  paid: boolean;
  paidAt: string | null;
  /** Nao pago e ainda sem os dados da transacao: so o webhook ou a volta do checkout trazem. */
  needsReturn?: boolean;
}

/**
 * Pagamento online do cardapio pela InfinitePay: cria o link do pedido,
 * confirma o pagamento (webhook ou consulta) e lanca o valor em `payments`.
 *
 * O webhook da InfinitePay NAO e assinado; por isso ele so serve de gatilho —
 * quem confirma de verdade e a consulta `payment_check`, feita por aqui.
 */
@Injectable()
export class InfinitePayService {
  private readonly logger = new Logger(InfinitePayService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
    @InjectModel(MenuOnline.name)
    private readonly menuModel: Model<MenuOnlineDocument>,
    private readonly client: InfinitePayClient,
  ) {}

  /* ---------------------------- Configuracao ---------------------------- */

  async getSettings(businessId: string) {
    const business = await this.businessModel
      .findById(new Types.ObjectId(businessId))
      .select('config.infinitepay')
      .lean()
      .exec();
    if (!business) throw new NotFoundException('Negócio não encontrado');
    const cfg = business.config?.infinitepay;
    return {
      handle: cfg?.handle ?? '',
      enabled: !!cfg?.enabled,
      /** Endereco que a InfinitePay chama quando um pagamento e aprovado. */
      webhookUrl: process.env.INFINITEPAY_WEBHOOK_PUBLIC_URL || null,
    };
  }

  async updateSettings(businessId: string, dto: UpdateInfinitePaySettingsDto) {
    const current = (await this.getSettings(businessId)).handle;
    const handle =
      dto.handle !== undefined ? normalizeHandle(dto.handle) : current;
    if (handle && !INFINITEPAY_HANDLE.test(handle)) {
      throw new BadRequestException(
        'InfiniteTag inválida. Use só letras, números, ponto, hífen ou sublinhado, sem espaços e até 50 caracteres (sem o $).',
      );
    }
    const enabled = dto.enabled ?? (await this.getSettings(businessId)).enabled;
    if (enabled && !handle) {
      throw new BadRequestException(
        'Informe a InfiniteTag para ativar a InfinitePay',
      );
    }
    await this.businessModel
      .updateOne(
        { _id: new Types.ObjectId(businessId) },
        { $set: { 'config.infinitepay': { handle, enabled } } },
      )
      .exec();
    this.logger.log(
      `InfinitePay configurada: negócio=${businessId} | ativa=${enabled}`,
    );
    return this.getSettings(businessId);
  }

  /* ------------------------------- Link -------------------------------- */

  private async activeConfig(businessId: Types.ObjectId) {
    const business = await this.businessModel
      .findById(businessId)
      .select('config.infinitepay')
      .lean()
      .exec();
    const cfg = business?.config?.infinitepay;
    return infinitePayActive(cfg) ? cfg : null;
  }

  /**
   * Garante o link de pagamento do pedido (idempotente: reaproveita o que ja
   * foi criado). `null` = a loja nao usa InfinitePay. Falha da API lanca 503.
   */
  async ensureCheckout(
    businessId: string,
    orderRef: string,
    redirectUrl?: string,
  ): Promise<{ checkoutUrl: string } | null> {
    const bizId = new Types.ObjectId(businessId);
    const order = await this.orderModel
      .findOne({ businessId: bizId, externalRef: orderRef })
      .exec();
    if (!order || !order.requestedPayment?.prepaid) {
      throw new NotFoundException('Pedido não encontrado');
    }
    return this.checkoutFor(order, redirectUrl, orderRef);
  }

  /** Link de um pedido criado no painel (cobra o total ou o sinal gravado no pedido). */
  async ensureCheckoutById(
    orderId: string,
    businessId: string,
  ): Promise<{ checkoutUrl: string }> {
    const order = Types.ObjectId.isValid(orderId)
      ? await this.orderModel
          .findOne({
            _id: orderId,
            businessId: new Types.ObjectId(businessId),
          })
          .exec()
      : null;
    if (!order?.infinitePay?.orderNsu) {
      throw new NotFoundException('Este pedido não tem pagamento InfinitePay');
    }
    const result = await this.checkoutFor(order);
    if (!result) {
      throw new BadRequestException(
        'A InfinitePay não está habilitada para esta loja',
      );
    }
    return result;
  }

  /** A loja cobra pela InfinitePay agora (integração ligada e InfiniteTag preenchida)? */
  async isActive(businessId: string): Promise<boolean> {
    return !!(await this.activeConfig(new Types.ObjectId(businessId)));
  }

  private async checkoutFor(
    order: OrderDocument,
    redirectUrl?: string,
    orderRef?: string,
  ): Promise<{ checkoutUrl: string } | null> {
    const bizId = order.businessId;
    const businessId = bizId.toString();
    const orderNsu = order.infinitePay?.orderNsu ?? orderRef;
    if (order.infinitePay?.checkoutUrl) {
      return { checkoutUrl: order.infinitePay.checkoutUrl };
    }
    const cfg = await this.activeConfig(bizId);
    if (!cfg || !orderNsu) return null;
    if (order.status === OrderStatus.CANCELADA) {
      throw new BadRequestException('Este pedido foi cancelado');
    }

    // Pedido do painel pode cobrar so um sinal (ou ter desconto de campanha): nesses casos o
    // link tem uma linha so, no valor cobrado, com os itens na descricao. Do contrario, um por item.
    const charge = order.infinitePay?.chargeAmount;
    const itemized = buildLinkItems(order.items, order.deliveryFee);
    const wanted = toCents(charge ?? order.total);
    const lines =
      sumCents(itemized) === wanted
        ? itemized
        : [
            {
              quantity: 1,
              price: wanted,
              description: describeOrderLine(
                charge !== undefined && charge < order.total - 0.009
                  ? `Sinal do pedido #${order.code}`
                  : `Pedido #${order.code}`,
                order.items,
              ),
            },
          ];
    const expected = toCents(charge ?? order.total);
    if (sumCents(lines) !== expected) {
      // Nunca cobrar um valor diferente do total do pedido.
      this.logger.error(
        `Link InfinitePay recusado: itens somam ${sumCents(lines)} e o total é ${expected} | #${order.code} | negócio: ${businessId}`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível gerar o pagamento deste pedido. Fale com a loja.',
      );
    }

    // A InfinitePay recusa links abaixo de R$ 1,00 (422 "Total price must be greater than 1").
    if (expected < INFINITEPAY_MIN_CENTS) {
      this.logger.error(
        `Link InfinitePay não criado: valor R$ ${fromCents(expected).toFixed(2)} abaixo do mínimo de R$ 1,00 da InfinitePay | #${order.code}`,
      );
      throw new ServiceUnavailableException(
        'A InfinitePay só aceita pagamentos a partir de R$ 1,00. Fale com a loja.',
      );
    }

    const redirect = redirectUrl ?? order.infinitePay?.redirectUrl;
    const webhookUrl = process.env.INFINITEPAY_WEBHOOK_PUBLIC_URL || undefined;
    let body: unknown;
    try {
      body = await this.client.createLink({
        handle: cfg.handle,
        items: lines,
        order_nsu: orderNsu,
        redirect_url: redirect,
        webhook_url: webhookUrl,
        customer: {
          name: order.customerName,
          email: order.customerEmail,
          phone_number: this.e164(order.customerPhone),
        },
        address: toLinkAddress(order.delivery?.dropoff),
      });
    } catch (error) {
      throw this.toHttpError(error, 'gerar o link de pagamento');
    }
    const checkoutUrl = parseLinkUrl(body);
    if (!checkoutUrl) {
      this.logger.error(
        `InfinitePay não devolveu a URL do link (chaves: ${Object.keys((body as object) ?? {}).join(',')}) | #${order.code}`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível gerar o pagamento agora. Tente novamente.',
      );
    }
    await this.orderModel
      .updateOne(
        { _id: order._id },
        {
          $set: {
            'infinitePay.orderNsu': orderNsu,
            'infinitePay.checkoutUrl': checkoutUrl,
            'infinitePay.redirectUrl': redirect,
          },
        },
      )
      .exec();
    this.logger.log(
      `Link InfinitePay criado: #${order.code} | negócio: ${businessId}`,
    );
    return { checkoutUrl };
  }

  private e164(phone?: string): string | undefined {
    const digits = (phone ?? '').replace(/\D/g, '');
    return digits.length === 10 || digits.length === 11
      ? `+55${digits}`
      : undefined;
  }

  private toHttpError(error: unknown, action: string): Error {
    if (error instanceof InfinitePayApiError) {
      if (error.code === 'external_checkout_not_enabled') {
        this.logger.error(
          'InfinitePay: a loja não habilitou o "Checkout externo" no app da InfinitePay',
        );
      }
      if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        return new ServiceUnavailableException(
          `A InfinitePay recusou ${action}. Confira a InfiniteTag e se o checkout externo está habilitado na conta.`,
        );
      }
    }
    return new ServiceUnavailableException(
      `Não foi possível falar com a InfinitePay agora (${action}). Tente novamente.`,
    );
  }

  /* ---------------------------- Confirmacao ----------------------------- */

  /** Webhook: acha o pedido pelo `order_nsu` e confirma consultando a InfinitePay. */
  async handleWebhook(
    payload: InfinitePayWebhookPayload,
  ): Promise<{ ok: true; paid: boolean }> {
    const nsu = payload?.order_nsu;
    if (typeof nsu !== 'string' || !nsu) {
      throw new BadRequestException('order_nsu ausente');
    }
    const order = await this.orderModel
      .findOne({ 'infinitePay.orderNsu': nsu })
      .exec();
    if (!order) {
      // Pedido que nao e nosso: 200 para a InfinitePay nao insistir.
      this.logger.warn('Webhook InfinitePay de pedido desconhecido');
      return { ok: true, paid: false };
    }
    const paid = await this.confirm(order, {
      transactionNsu: payload.transaction_nsu,
      invoiceSlug: payload.invoice_slug,
      receiptUrl: payload.receipt_url,
    });
    return { ok: true, paid };
  }

  /** Cliente voltou do checkout (ou apertou "verificar"): confirma pela consulta. */
  async verifyByRef(
    slug: string,
    orderRef: string,
    hint: {
      transactionNsu?: string;
      invoiceSlug?: string;
      receiptUrl?: string;
    },
  ): Promise<InfinitePayPaymentStatus> {
    const order = await this.findBySlugAndRef(slug, orderRef);
    await this.confirm(order, hint);
    return this.statusOf(await this.orderModel.findById(order._id).exec());
  }

  /** Operador do painel pediu "verificar pagamento". */
  async verifyById(
    id: string,
    businessId: string,
  ): Promise<InfinitePayPaymentStatus> {
    const order = await this.orderModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .exec();
    if (!order?.infinitePay?.orderNsu) {
      throw new NotFoundException('Este pedido não tem pagamento InfinitePay');
    }
    await this.confirm(order, {});
    return this.statusOf(await this.orderModel.findById(order._id).exec());
  }

  /** Link de um pedido da vitrine (gera se ainda nao existir). */
  async checkoutByRef(
    slug: string,
    orderRef: string,
    redirectUrl?: string,
  ): Promise<{ checkoutUrl: string }> {
    const order = await this.findBySlugAndRef(slug, orderRef);
    const result = await this.ensureCheckout(
      String(order.businessId),
      orderRef,
      redirectUrl,
    );
    if (!result) throw new NotFoundException('Pedido não encontrado');
    return result;
  }

  private async findBySlugAndRef(
    slug: string,
    orderRef: string,
  ): Promise<OrderDocument> {
    const menu = await this.menuModel
      .findOne({ slug })
      .select('businessId')
      .lean()
      .exec();
    const order = menu
      ? await this.orderModel
          .findOne({ businessId: menu.businessId, externalRef: orderRef })
          .exec()
      : null;
    if (!order || !order.requestedPayment?.prepaid) {
      throw new NotFoundException('Pedido não encontrado');
    }
    return order;
  }

  private statusOf(order: OrderDocument | null): InfinitePayPaymentStatus {
    const paidAt = order?.infinitePay?.paidAt;
    return {
      paid: !!paidAt,
      paidAt: paidAt ? paidAt.toISOString() : null,
      needsReturn:
        !paidAt &&
        !(
          order?.infinitePay?.transactionNsu && order?.infinitePay?.invoiceSlug
        ),
    };
  }

  /**
   * Consulta a InfinitePay e, estando pago, lanca o pagamento — uma unica vez,
   * mesmo com webhook repetido e consulta do cliente chegando juntos.
   */
  private async confirm(
    order: OrderDocument,
    hint: {
      transactionNsu?: string;
      invoiceSlug?: string;
      receiptUrl?: string;
    },
  ): Promise<boolean> {
    if (order.infinitePay?.paidAt) return true;
    const cfg = await this.activeConfig(order.businessId);
    // Integracao desligada depois do pedido: ainda vale confirmar o que ja foi cobrado.
    const handle =
      cfg?.handle ??
      (
        await this.businessModel
          .findById(order.businessId)
          .select('config.infinitepay')
          .lean()
          .exec()
      )?.config?.infinitepay?.handle;
    if (!handle || !order.infinitePay?.orderNsu) return false;

    // A InfinitePay so responde a consulta com os 4 dados (tag, order_nsu, transaction_nsu e
    // slug da fatura); sem os dois ultimos devolve `success:false` mesmo se ja foi paga.
    // Eles chegam pelo webhook ou na volta do checkout — sem eles nao ha o que consultar.
    const transactionNsu =
      hint.transactionNsu ?? order.infinitePay.transactionNsu;
    const invoiceSlug = hint.invoiceSlug ?? order.infinitePay.invoiceSlug;
    if (!transactionNsu || !invoiceSlug) return false;

    let check: InfinitePayCheckResponse;
    try {
      check = await this.client.paymentCheck({
        handle,
        order_nsu: order.infinitePay.orderNsu,
        transaction_nsu: transactionNsu,
        slug: invoiceSlug,
      });
    } catch (error) {
      // 4xx = ainda nao existe pagamento/dados nao batem; 5xx/rede = tentar de novo.
      if (
        error instanceof InfinitePayApiError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        return false;
      }
      throw this.toHttpError(error, 'consultar o pagamento');
    }
    if (!check.paid) return false;

    // Pedido do painel pode cobrar so um sinal; o link cobra `chargeAmount`.
    const chargeAmount = order.infinitePay.chargeAmount ?? order.total;
    const expected = toCents(chargeAmount);
    if (check.amount !== expected) {
      // Nunca confirmar um valor diferente do pedido sem olho humano.
      this.logger.error(
        `InfinitePay: valor divergente (pago ${check.amount}, pedido ${expected}) | #${order.code} | negócio: ${order.businessId.toString()}`,
      );
      return false;
    }

    const now = new Date();
    const cancelled = order.status === OrderStatus.CANCELADA;
    const set: Record<string, unknown> = {
      'infinitePay.paidAt': now,
      'infinitePay.captureMethod': check.capture_method,
      'infinitePay.installments': check.installments,
      'infinitePay.paidAmount':
        check.paid_amount !== undefined
          ? fromCents(check.paid_amount)
          : undefined,
      'infinitePay.transactionNsu': hint.transactionNsu,
      'infinitePay.invoiceSlug': hint.invoiceSlug,
      'infinitePay.receiptUrl': hint.receiptUrl,
    };
    for (const key of Object.keys(set)) {
      if (set[key] === undefined) delete set[key];
    }
    const update: Record<string, unknown> = { $set: set };
    if (!cancelled) {
      update.$push = {
        payments: {
          method: methodOfCapture(check.capture_method) as PaymentMethod,
          amount: chargeAmount,
          kind: OrderPaymentKind.SINAL,
          paidAt: now,
        },
      };
    }
    const res = await this.orderModel
      .updateOne(
        { _id: order._id, 'infinitePay.paidAt': { $exists: false } },
        update,
      )
      .exec();
    if (res.modifiedCount === 0) return true; // outra chamada confirmou primeiro

    if (cancelled) {
      this.logger.error(
        `InfinitePay: pagamento recebido de pedido CANCELADO — reembolsar | #${order.code} | negócio: ${order.businessId.toString()}`,
      );
    } else {
      this.logger.log(
        `Pagamento InfinitePay confirmado: #${order.code} | ${check.capture_method} | negócio: ${order.businessId.toString()}`,
      );
    }
    return true;
  }
}
