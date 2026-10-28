import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { InternalRoute } from '../common/decorators/internal-route.decorator';
import { Role } from '../common/enums/role.enum';
import { DeliverySettingsService } from './delivery-settings.service';
import { UberDirectService } from './uber-direct.service';
import {
  DispatchUberDeliveryDto,
  PanelDeliveryQuoteDto,
  UpdateDeliverySettingsDto,
} from './dto/delivery.dto';

/** Modo de entrega, Pix e conta Uber Direct da loja — so o dono (tem segredo). */
@Controller('menu/delivery-settings')
@Roles(Role.OWNER)
export class DeliverySettingsController {
  constructor(private readonly settings: DeliverySettingsService) {}

  @Get()
  get(@CurrentUser() user: any) {
    return this.settings.get(user.businessId);
  }

  @Put()
  update(@CurrentUser() user: any, @Body() dto: UpdateDeliverySettingsDto) {
    return this.settings.update(user.businessId, dto);
  }

  /** Pede um token a Uber com as credenciais gravadas. */
  @Post('uber/test')
  @HttpCode(200)
  test(@CurrentUser() user: any) {
    return this.settings.test(user.businessId);
  }
}

/** Cotacao da Uber para o formulario de pedido do painel (todos que operam pedidos). */
@Controller('delivery')
export class PanelDeliveryController {
  constructor(private readonly uber: UberDirectService) {}

  @Post('quote')
  @HttpCode(200)
  quote(@CurrentUser() user: any, @Body() dto: PanelDeliveryQuoteDto) {
    return this.uber.quoteForPanel(
      user.businessId,
      dto.address,
      dto.subtotal,
      dto.phone,
    );
  }
}

/**
 * Entregador da Uber para uma encomenda. Recotar/solicitar/atualizar: todos
 * que operam pedidos. Cancelar a corrida: mesmo nivel de cancelar encomenda.
 */
@Controller('orders/:id/uber-delivery')
export class OrderUberDeliveryController {
  constructor(private readonly uber: UberDirectService) {}

  @Post('quote')
  @HttpCode(200)
  quote(@CurrentUser() user: any, @Param('id') id: string) {
    return this.uber.requote(id, user.businessId);
  }

  @Post()
  dispatch(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: DispatchUberDeliveryDto,
  ) {
    return this.uber.dispatch(
      id,
      user.businessId,
      user.uid,
      dto.quoteId,
      dto.acceptFeeIncrease,
    );
  }

  @Post('sync')
  @HttpCode(200)
  sync(@CurrentUser() user: any, @Param('id') id: string) {
    return this.uber.sync(id, user.businessId);
  }

  @Post('cancel')
  @HttpCode(200)
  @Roles(Role.OWNER, Role.GERENTE)
  cancel(@CurrentUser() user: any, @Param('id') id: string) {
    return this.uber.cancel(id, user.businessId);
  }
}

/**
 * Webhook da Uber Direct. A Uber chama o my-store-cardapio-web-back-api
 * (publico), que repassa o corpo CRU aqui com a assinatura interna; a
 * assinatura da Uber (`X-Uber-Signature`) vem junto e e conferida no servico.
 */
@Controller('internal/uber-direct')
@InternalRoute()
export class InternalUberWebhookController {
  constructor(private readonly uber: UberDirectService) {}

  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
    @Headers('x-uber-signature') signature?: string,
  ) {
    return this.uber.handleWebhook(body, req.rawBody, signature);
  }
}
