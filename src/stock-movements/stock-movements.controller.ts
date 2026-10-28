import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { StockMovementsService } from './stock-movements.service';
import { BusinessService } from '../business/business.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';

@Controller('stock-movements')
export class StockMovementsController {
  constructor(
    private readonly stockMovementsService: StockMovementsService,
    private readonly businessService: BusinessService,
  ) {}

  @Post()
  @Roles(Role.OWNER, Role.GERENTE)
  async create(@CurrentUser() user: any, @Body() dto: CreateStockMovementDto) {
    if (user.role === Role.GERENTE) {
      const perms = await this.businessService.getEffectivePermissions(
        user.businessId,
        user.role,
      );
      if (!perms.canManageStock) {
        throw new ForbiddenException('Sem permissão para movimentar estoque');
      }
    }
    return this.stockMovementsService.createManual(
      user.uid,
      user.businessId,
      dto,
    );
  }

  @Get()
  findAll(
    @CurrentUser() user: any,
    @Query('productId') productId?: string,
    @Query('type') type?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '30',
  ) {
    return this.stockMovementsService.findAll(user.businessId, {
      productId,
      type,
      dateFrom,
      dateTo,
      page: Math.max(1, parseInt(page, 10) || 1),
      limit: Math.min(100, Math.max(1, parseInt(limit, 10) || 30)),
    });
  }
}
