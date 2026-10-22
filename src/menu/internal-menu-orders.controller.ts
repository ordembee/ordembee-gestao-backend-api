import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  BadRequestException,
} from '@nestjs/common';
import { InternalRoute } from '../common/decorators/internal-route.decorator';
import { MenuOrdersService } from './menu-orders.service';
import { MenuService } from './menu.service';
import { MenuOrderDto } from './dto/menu-order.dto';

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
}

/**
 * Canal "ao vivo" do cardapio (disponibilidade, descricao e foto). Tambem so
 * para o my-store-cardapio-web-back-api, que serve ao publico com cache curto.
 */
@Controller('internal/menus')
@InternalRoute()
export class InternalMenusController {
  constructor(private readonly menuService: MenuService) {}

  @Get(':slug/live')
  live(@Param('slug') slug: string) {
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
      throw new BadRequestException('Slug inválido');
    }
    return this.menuService.liveFor(slug);
  }
}
