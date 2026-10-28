import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { InternalRoute } from '../common/decorators/internal-route.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { InfinitePayService } from './infinitepay.service';
import {
  InfinitePayWebhookPayload,
  InternalPaymentDto,
  UpdateInfinitePaySettingsDto,
} from './dto/infinitepay.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{1,60}$/;

/** InfiniteTag e liga/desliga da InfinitePay — so o dono. */
@Controller('menu/infinitepay-settings')
@Roles(Role.OWNER)
export class InfinitePaySettingsController {
  constructor(private readonly infinitePay: InfinitePayService) {}

  @Get()
  get(@CurrentUser() user: any) {
    return this.infinitePay.getSettings(user.businessId);
  }

  @Put()
  update(@CurrentUser() user: any, @Body() dto: UpdateInfinitePaySettingsDto) {
    return this.infinitePay.updateSettings(user.businessId, dto);
  }
}

/** "Verificar pagamento" no detalhe do pedido (todos que operam pedidos). */
@Controller('orders/:id/infinitepay')
export class OrderInfinitePayController {
  constructor(private readonly infinitePay: InfinitePayService) {}

  @Post('check')
  @HttpCode(200)
  check(@CurrentUser() user: any, @Param('id') id: string) {
    return this.infinitePay.verifyById(id, user.businessId);
  }

  /** Gera o link de novo (a criacao do pedido pode ter falhado na InfinitePay). */
  @Post('link')
  @HttpCode(200)
  link(@CurrentUser() user: any, @Param('id') id: string) {
    return this.infinitePay.ensureCheckoutById(id, user.businessId);
  }
}

/**
 * Webhook da InfinitePay. Ela chama o ordembee-cardapio-web-backend-api (publico),
 * que repassa para ca com a assinatura interna. O corpo nao e assinado pela
 * InfinitePay: ele so aponta o pedido, e o pagamento e confirmado por consulta.
 */
@Controller('internal/infinitepay')
@InternalRoute()
export class InternalInfinitePayController {
  constructor(private readonly infinitePay: InfinitePayService) {}

  @Post('webhook')
  @HttpCode(200)
  webhook(@Body() body: InfinitePayWebhookPayload) {
    return this.infinitePay.handleWebhook(body);
  }
}

/** Rotas por pedido, chamadas pelo cardapio (nunca direto pelo cliente). */
@Controller('internal/menu-orders/:ref')
@InternalRoute()
export class InternalMenuPaymentsController {
  constructor(private readonly infinitePay: InfinitePayService) {}

  private check(ref: string, slug: string) {
    if (!UUID.test(ref) || !SLUG.test(slug)) {
      throw new BadRequestException('Pedido inválido');
    }
  }

  /** Cliente voltou do checkout: confirma na InfinitePay. */
  @Post('payment-check')
  @HttpCode(200)
  verify(@Param('ref') ref: string, @Body() dto: InternalPaymentDto) {
    this.check(ref, dto.slug);
    return this.infinitePay.verifyByRef(dto.slug, ref, {
      transactionNsu: dto.transactionNsu,
      invoiceSlug: dto.invoiceSlug,
      receiptUrl: dto.receiptUrl,
    });
  }

  /** Link de pagamento (gera de novo se a criacao falhou no pedido). */
  @Post('payment-link')
  @HttpCode(200)
  link(@Param('ref') ref: string, @Body() dto: InternalPaymentDto) {
    this.check(ref, dto.slug);
    return this.infinitePay.checkoutByRef(dto.slug, ref, dto.redirectUrl);
  }
}
