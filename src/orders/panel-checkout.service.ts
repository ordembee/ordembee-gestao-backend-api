import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
import {
  Business,
  BusinessDocument,
} from '../business/schemas/business.schema';
import {
  DeliveryQuote,
  DeliveryQuoteDocument,
} from '../delivery/schemas/delivery-quote.schema';
import {
  DeliveryProvider,
  MenuOnline,
  MenuOnlineDocument,
} from '../menu/schemas/menu-online.schema';
import { uberMissing } from '../delivery/delivery-settings.service';
import {
  StructuredAddress,
  dropoffKey,
  toE164BR,
} from '../delivery/uber-direct.util';
import { InfinitePayService } from '../payments/infinitepay.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderFulfillment } from './schemas/order.schema';
import type { OrderDelivery } from './schemas/order.schema';
import type { PanelOrderExtras } from './orders.service';

const reject = (reason: string, message: string) =>
  new ConflictException({ statusCode: 409, reason, message });

export interface CheckoutOptions {
  /** A loja aceita retirada (config. do cardapio). */
  pickup: boolean;
  /** Entrega pela propria loja (taxa manual). Exclui a Uber. */
  ownDelivery: boolean;
  /** Taxa fixa da entrega propria, para preencher o campo. */
  ownDeliveryFee: number;
  /** Entrega pela Uber Direct: escolhida na loja e com credenciais prontas. */
  uber: boolean;
  /** A loja cobra pelo link da InfinitePay. */
  infinitePay: boolean;
}

/**
 * Pedido criado no painel com entrega Uber e/ou cobranca pelo link da
 * InfinitePay. Valida tudo ANTES de gravar o pedido: o frete sai da cotacao
 * guardada aqui e o valor cobrado sai do total calculado no servidor.
 */
@Injectable()
export class PanelCheckoutService {
  private readonly logger = new Logger(PanelCheckoutService.name);

  constructor(
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
    @InjectModel(MenuOnline.name)
    private readonly menuModel: Model<MenuOnlineDocument>,
    @InjectModel(DeliveryQuote.name)
    private readonly quoteModel: Model<DeliveryQuoteDocument>,
    private readonly infinitePay: InfinitePayService,
  ) {}

  async options(businessId: string): Promise<CheckoutOptions> {
    const bizId = new Types.ObjectId(businessId);
    const [business, menu] = await Promise.all([
      this.businessModel.findById(bizId).select('config.uber').lean().exec(),
      this.menuModel
        .findOne({ businessId: bizId })
        .select('store.delivery')
        .lean()
        .exec(),
    ]);
    // Mesmos padroes do cardapio: sem configuracao, retirada e entrega propria ligadas.
    const delivery = menu?.store?.delivery;
    const deliveryOn = delivery?.deliveryEnabled !== false;
    const viaUber = delivery?.deliveryProvider === DeliveryProvider.UBER;
    return {
      pickup: delivery?.pickupEnabled !== false,
      ownDelivery: deliveryOn && !viaUber,
      ownDeliveryFee: delivery?.deliveryFee ?? 0,
      uber:
        deliveryOn &&
        viaUber &&
        uberMissing(business?.config?.uber, undefined, true).length === 0,
      infinitePay: await this.infinitePay.isActive(businessId),
    };
  }

  async prepare(
    businessId: string,
    dto: CreateOrderDto,
  ): Promise<PanelOrderExtras> {
    const extras: PanelOrderExtras = {};
    const options =
      dto.uberDelivery || dto.infinitePay
        ? await this.options(businessId)
        : null;

    if (dto.uberDelivery) {
      if (!options?.uber) {
        throw new BadRequestException(
          'A Uber Direct não está configurada para esta loja',
        );
      }
      if (dto.fulfillment !== OrderFulfillment.ENTREGA) {
        throw new BadRequestException('Entrega pela Uber exige o modo Entrega');
      }
      extras.delivery = await this.acceptDelivery(businessId, dto);
    }

    if (dto.infinitePay) {
      if (!options?.infinitePay) {
        throw new BadRequestException(
          'A InfinitePay não está habilitada para esta loja',
        );
      }
      if ((dto.payments ?? []).some((p) => p.amount > 0)) {
        throw new BadRequestException(
          'Escolha o pagamento pela InfinitePay ou um pagamento já recebido, não os dois',
        );
      }
      extras.infinitePay = {
        orderNsu: randomUUID(),
        amount: dto.infinitePay.amount,
      };
    }
    return extras;
  }

  /** Cotacao que o operador viu: da mesma loja, para o mesmo destino e ainda valida. */
  private async acceptDelivery(
    businessId: string,
    dto: CreateOrderDto,
    now = new Date(),
  ): Promise<OrderDelivery> {
    const input = dto.uberDelivery!;
    const a = input.address;
    const recipientName = input.recipientName.trim();
    if (recipientName.split(/\s+/).length < 2) {
      throw new BadRequestException(
        'Informe nome e sobrenome de quem vai receber',
      );
    }
    const phone = toE164BR(input.recipientPhone);
    if (!phone) {
      throw new BadRequestException('Telefone de quem recebe inválido');
    }
    const address: StructuredAddress = {
      cep: a.cep,
      street: a.street.trim(),
      number: a.number.trim(),
      district: a.district.trim(),
      city: a.city.trim(),
      state: a.state.toUpperCase(),
      complement: a.complement?.trim() || undefined,
    };
    const quote = await this.quoteModel
      .findOne({
        businessId: new Types.ObjectId(businessId),
        quoteId: input.quoteId,
        orderId: { $exists: false },
      })
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
    return {
      provider: 'UBER',
      quoteId: quote.quoteId,
      quotedFee: quote.fee,
      dropoff: address,
      recipientName,
      recipientPhone: phone,
      instructions: input.instructions?.trim() || undefined,
      events: [],
    };
  }

  /**
   * Depois de gravar o pedido: prende a cotacao a ele (nao vale para outro) e
   * gera o link da InfinitePay. Falha no link nao desfaz o pedido — o operador
   * gera de novo pelo detalhe.
   */
  async finish(
    order: { _id: unknown; code: number },
    businessId: string,
    extras: PanelOrderExtras,
  ): Promise<void> {
    if (extras.delivery) {
      await this.quoteModel
        .updateOne(
          {
            businessId: new Types.ObjectId(businessId),
            quoteId: extras.delivery.quoteId,
          },
          { $set: { orderId: order._id } },
        )
        .exec();
    }
    if (extras.infinitePay) {
      try {
        await this.infinitePay.ensureCheckoutById(
          String(order._id),
          businessId,
        );
      } catch (error) {
        this.logger.warn(
          `Pedido #${order.code} criado sem link InfinitePay: ${(error as Error).message}`,
        );
      }
    }
  }
}
