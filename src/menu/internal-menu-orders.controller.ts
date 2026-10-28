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
import {
  MenuDeliveryQuoteDto,
  MenuPaymentClaimDto,
} from '../delivery/dto/delivery.dto';

const SLUG = /^[a-z0-9-]{1,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Entrada dos pedidos do cardapio digital. NAO e publica: so o
 * my-store-cardapio-web-back-api, com a assinatura HMAC, chega aqui (`@InternalRoute`).
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
 * para o my-store-cardapio-web-back-api, que serve ao publico com cache curto.
 */
@Controller('internal/menus')
@InternalRoute()
export class InternalMenusController {
  constructor(private readonly uberDirect: UberDirectService) {}

  /** Frete da Uber para o endereco do checkout (o pedido usa esta cotacao). */
  @Post(':slug/delivery-quote')
  @HttpCode(200)
  quote(@Param('slug') slug: string, @Body() dto: MenuDeliveryQuoteDto) {
    if (!SLUG.test(slug)) throw new BadRequestException('Slug inválido');
    return this.uberDirect.quoteForMenu(slug, dto.address, dto.subtotal);
  }
}
