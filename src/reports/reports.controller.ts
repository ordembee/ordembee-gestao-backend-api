import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';

@Controller('reports')
@Roles(Role.OWNER)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('overview')
  getOverview(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('campaign') campaign?: string,
  ) {
    return this.reportsService.getOverview(
      user.businessId,
      dateFrom,
      dateTo,
      campaign,
    );
  }

  @Get('period-comparison')
  getPeriodComparison(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('campaign') campaign?: string,
  ) {
    return this.reportsService.getPeriodComparison(
      user.businessId,
      dateFrom,
      dateTo,
      campaign,
    );
  }

  @Get('sales-by-period')
  getSalesByPeriod(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('groupBy') groupBy?: 'day' | 'week' | 'month',
    @Query('campaign') campaign?: string,
  ) {
    return this.reportsService.getSalesByPeriod(
      user.businessId,
      dateFrom,
      dateTo,
      groupBy ?? 'day',
      campaign,
    );
  }

  @Get('top-products')
  getTopProducts(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('limit') limit?: string,
    @Query('campaign') campaign?: string,
  ) {
    return this.reportsService.getTopProducts(
      user.businessId,
      dateFrom,
      dateTo,
      limit ? parseInt(limit) : 10,
      campaign,
    );
  }

  @Get('abc-curve')
  getABCCurve(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('campaign') campaign?: string,
  ) {
    return this.reportsService.getABCCurve(
      user.businessId,
      dateFrom,
      dateTo,
      campaign,
    );
  }

  @Get('waste')
  getWasteReport(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.reportsService.getWasteReport(
      user.businessId,
      dateFrom,
      dateTo,
    );
  }

  @Get('breakeven')
  getBreakeven(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.reportsService.getBreakeven(user.businessId, dateFrom, dateTo);
  }

  @Get('cash-flow')
  getCashFlow(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.reportsService.getCashFlow(user.businessId, dateFrom, dateTo);
  }

  @Get('by-channel')
  getByChannel(
    @CurrentUser() user: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('campaign') campaign?: string,
  ) {
    return this.reportsService.getByChannel(
      user.businessId,
      dateFrom,
      dateTo,
      campaign,
    );
  }
}
