import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SalesService } from './sales.service';
import { BusinessService } from '../business/business.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { CreateSaleDto } from './dto/create-sale.dto';
import { UpdatePaymentsDto } from './dto/update-payments.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';

@Controller('sales')
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly businessService: BusinessService,
  ) {}

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateSaleDto) {
    return this.salesService.create(user.uid, user.businessId, dto);
  }

  @Get()
  @Roles(Role.OWNER, Role.GERENTE)
  findAll(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('operatorId') operatorId?: string,
    @Query('campaign') campaign?: string,
  ) {
    return this.salesService.findAll(user.businessId, user.role, {
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 10,
      status: status || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      operatorId: operatorId || undefined,
      campaign: campaign || undefined,
    });
  }

  @Get('summary/day')
  getDaySummary(@CurrentUser() user: any) {
    return this.salesService.getDaySummary(user.businessId);
  }

  @Get('summary/operator-close')
  getOperatorCashClose(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('operatorId') operatorId?: string,
  ) {
    const targetOperatorId =
      user.role === Role.OWNER || user.role === Role.GERENTE
        ? operatorId
        : undefined;
    return this.salesService.getOperatorCashClose(
      user.uid,
      user.businessId,
      dateFrom,
      dateTo,
      targetOperatorId,
      user.role,
    );
  }

  @Get('summary/cashclose')
  @Roles(Role.OWNER)
  getCashClose(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.salesService.getCashClose(user.businessId, dateFrom, dateTo);
  }

  @Get(':id')
  @Roles(Role.OWNER, Role.GERENTE)
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.salesService.findOne(id, user.businessId);
  }

  @Patch(':id')
  @Roles(Role.OWNER)
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateSaleDto,
  ) {
    return this.salesService.update(
      id,
      user.businessId,
      user.uid,
      user._id,
      dto,
    );
  }

  @Patch(':id/cancel')
  @Roles(Role.OWNER, Role.GERENTE)
  async cancel(@CurrentUser() user: any, @Param('id') id: string) {
    if (user.role === Role.GERENTE) {
      const perms = await this.businessService.getEffectivePermissions(
        user.businessId,
        user.role,
      );
      if (!perms.canCancelSales) {
        throw new ForbiddenException('Sem permissão para cancelar vendas');
      }
    }
    return this.salesService.cancel(id, user.businessId);
  }

  @Patch(':id/payments')
  @Roles(Role.OWNER)
  updatePayments(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdatePaymentsDto,
  ) {
    return this.salesService.updatePayments(id, user.businessId, dto.payments);
  }

  @Patch(':id/settle-debt')
  @Roles(Role.OWNER, Role.GERENTE)
  settleDebt(@CurrentUser() user: any, @Param('id') id: string) {
    return this.salesService.settleDebt(id, user.businessId, user.uid);
  }
}
