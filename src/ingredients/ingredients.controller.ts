import {
  Body,
  ForbiddenException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { parsePageRequest } from '../common/pagination/pagination';
import { IngredientsService } from './ingredients.service';
import { BusinessService } from '../business/business.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { IngredientType } from './schemas/ingredient.schema';

@Controller('ingredients')
@Roles(Role.OWNER, Role.GERENTE)
export class IngredientsController {
  constructor(
    private readonly ingredientsService: IngredientsService,
    private readonly businessService: BusinessService,
  ) {}

  private actorOf(user: any) {
    return {
      uid: user.uid,
      name: user.name || user.email,
      role: user.role,
    };
  }

  /** CAIXA so entra se o dono liberou canEditIngredientPrices. */
  private async assertCashierCanEditPrices(user: any): Promise<void> {
    if (user.role !== Role.CAIXA) return;
    const perms = await this.businessService.getEffectivePermissions(
      user.businessId,
      user.role,
    );
    // Efetivo do CAIXA parte de "tudo true": checa a flag gravada de fato.
    if (perms.canEditIngredientPrices !== true) {
      throw new ForbiddenException(
        'Sem permissão para editar preços de ingredientes',
      );
    }
  }

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateIngredientDto) {
    return this.ingredientsService.create(
      user.businessId,
      dto,
      this.actorOf(user),
    );
  }

  @Get()
  @Roles(Role.OWNER, Role.GERENTE, Role.CAIXA)
  async findAll(
    @CurrentUser() user: any,
    @Query('type') type?: IngredientType,
    @Query('search') search?: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    await this.assertCashierCanEditPrices(user);
    return this.ingredientsService.findAll(
      user.businessId,
      type,
      search,
      includeInactive === 'true',
      parsePageRequest(page, limit),
    );
  }

  /** Histórico bruto de preços (gráfico de evolução). OWNER/GERENTE. */
  @Get('price-history')
  priceHistory(
    @CurrentUser() user: any,
    @Query('ingredientId') ingredientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.ingredientsService.getPriceHistory(user.businessId, {
      ingredientId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  /** Aumentos e quedas por ingrediente no período. */
  @Get('price-variation')
  priceVariation(
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const end = to ? new Date(to) : new Date();
    const start = from
      ? new Date(from)
      : new Date(end.getTime() - 90 * 24 * 3600 * 1000);
    return this.ingredientsService.getPriceVariation(
      user.businessId,
      start,
      end,
    );
  }

  @Get(':id')
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.ingredientsService.findOne(id, user.businessId);
  }

  @Patch(':id')
  @Roles(Role.OWNER, Role.GERENTE, Role.CAIXA)
  async update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateIngredientDto,
  ) {
    if (user.role === Role.CAIXA) {
      await this.assertCashierCanEditPrices(user);
      // Caixa mexe so no preco: descarta nome, unidade, ativo, receita etc.
      dto = {
        purchasePrice: dto.purchasePrice,
        quantityPurchased: dto.quantityPurchased,
      };
    }
    return this.ingredientsService.update(
      id,
      user.businessId,
      dto,
      this.actorOf(user),
    );
  }

  @Delete(':id')
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.ingredientsService.remove(id, user.businessId);
  }
}
