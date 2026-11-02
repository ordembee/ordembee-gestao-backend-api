import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  BadRequestException,
} from '@nestjs/common';
import { InternalRoute } from '../common/decorators/internal-route.decorator';
import { MenuOrdersService } from './menu-orders.service';
import { MenuOrderDto } from './dto/menu-order.dto';
import { UberDirectService } from '../delivery/uber-direct.service';
import { OwnDeliveryService } from '../delivery/own-delivery.service';
import { usesDistanceTiers } from '../delivery/own-delivery.util';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MenuOnline, MenuOnlineDocument } from './schemas/menu-online.schema';
import {
  MenuDeliveryQuoteDto,
  MenuPaymentClaimDto,
} from '../delivery/dto/delivery.dto';

const SLUG = /^[a-z0-9-]{1,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Entrada dos pedidos do cardapio digital. NAO e publica: so o
 * ordembee-cardapio-web-backend-api, com a assinatura HMAC, chega aqui (`@InternalRoute`).
 */
@Controller('internal/menu-orders')
@InternalRoute()
export class InternalMenuOrdersController {
  constructor(private readonly menuOrdersService: MenuOrdersService) {}

  @Post()
  @HttpCode(201)
  create(
    @Body() dto: MenuOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey && idempotencyKey !== dto.orderRef) {
      throw new BadRequestException('Idempotency-Key diferente do orderRef');
    }
    return this.menuOrdersService.create(dto);
  }

  /** Cliente tocou "Já paguei" (Pix antecipado). O `ref` e o UUID do pedido. */
  @Post(':ref/payment-claim')
  @HttpCode(200)
  claimPayment(@Param('ref') ref: string, @Body() dto: MenuPaymentClaimDto) {
    if (!UUID.test(ref)) throw new BadRequestException('Pedido inválido');
    return this.menuOrdersService.claimPayment(dto.slug, ref);
  }
}

/**
 * Canal "ao vivo" do cardapio (disponibilidade, descricao e foto). Tambem so
 * para o ordembee-cardapio-web-backend-api, que serve ao publico com cache curto.
 */
@Controller('internal/menus')
@InternalRoute()
export class InternalMenusController {
  constructor(
    private readonly uberDirect: UberDirectService,
    private readonly ownDelivery: OwnDeliveryService,
    @InjectModel(MenuOnline.name)
    private readonly menuModel: Model<MenuOnlineDocument>,
  ) {}

  /**
   * Frete para o endereco do checkout (o pedido usa esta cotacao): por
   * distancia na entrega propria com faixas, senao a cotacao da Uber.
   */
  @Post(':slug/delivery-quote')
  @HttpCode(200)
  async quote(@Param('slug') slug: string, @Body() dto: MenuDeliveryQuoteDto) {
    if (!SLUG.test(slug)) throw new BadRequestException('Slug inválido');
    const menu = await this.menuModel
      .findOne({ slug })
      .select('store.delivery')
      .lean<Pick<MenuOnline, 'store'>>()
      .exec();
    if (usesDistanceTiers(menu?.store?.delivery)) {
      return this.ownDelivery.quoteForMenu(slug, dto.address);
    }
    return this.uberDirect.quoteForMenu(slug, dto.address, dto.subtotal);
  }
}
