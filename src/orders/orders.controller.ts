import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { AddOrderPaymentDto } from './dto/add-order-payment.dto';
import { DeliverOrderDto } from './dto/deliver-order.dto';
import { OrderStatus } from './schemas/order.schema';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(user.uid, user.businessId, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('scope') scope?: 'all' | 'today' | 'deliveredToday' | 'open' | 'late',
    @Query('status') status?: string,
    @Query('campaign') campaign?: string,
    @Query('customerId') customerId?: string,
    @Query('search') search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.ordersService.findAll(user.businessId, {
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
      scope: scope || 'all',
      status: status || undefined,
      campaign: campaign || undefined,
      customerId: customerId || undefined,
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    });
  }

  /** Contadores das abas (todas / hoje / entregues hoje / atrasadas). */
  @Get('summary')
  getSummary(@CurrentUser() user: any) {
    return this.ordersService.getSummary(user.businessId);
  }

  /**
   * Pedidos do cardapio digital criados depois de `since` (ISO) — consultado
   * a cada poucos segundos pelo painel para tocar o alerta de pedido novo.
   */
  @Get('menu-feed')
  getMenuFeed(@CurrentUser() user: any, @Query('since') since?: string) {
    return this.ordersService.getMenuFeed(user.businessId, since);
  }

  @Get(':id')
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.ordersService.findOne(id, user.businessId);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.ordersService.update(id, user.businessId, user.uid, dto);
  }

  /** Avanca/corrige o status dentro do fluxo (pendente, em produção, pronto). */
  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateStatus(
      id,
      user.businessId,
      user.uid,
      dto.status as OrderStatus,
    );
  }

  /** Sinal / parcela paga antes da entrega. */
  @Post(':id/payments')
  addPayment(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: AddOrderPaymentDto,
  ) {
    return this.ordersService.addPayment(id, user.businessId, user.uid, dto);
  }

  /** Conclui a encomenda: quita o saldo e registra a venda do dia. */
  @Post(':id/deliver')
  deliver(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: DeliverOrderDto,
  ) {
    return this.ordersService.deliver(id, user.businessId, user.uid, dto);
  }

  /**
   * Cancelar devolve estoque (e desfaz a venda, se ja tiver sido entregue) —
   * mesmo nivel de acesso do cancelamento de venda.
   */
  @Patch(':id/cancel')
  @Roles(Role.OWNER, Role.GERENTE)
  cancel(@CurrentUser() user: any, @Param('id') id: string) {
    return this.ordersService.cancel(id, user.businessId, user.uid);
  }
}
