import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PricingsService } from './pricings.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { CreatePricingDto } from './dto/create-pricing.dto';
import { UpdatePricingDto } from './dto/update-pricing.dto';

@Controller('pricings')
@Roles(Role.OWNER, Role.GERENTE)
export class PricingsController {
  constructor(private readonly pricingsService: PricingsService) {}

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreatePricingDto) {
    return this.pricingsService.create(user.businessId, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: any,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.pricingsService.findAll(
      user.businessId,
      includeInactive === 'true',
    );
  }

  @Get(':id')
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.pricingsService.findOne(id, user.businessId);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdatePricingDto,
  ) {
    return this.pricingsService.update(id, user.businessId, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.pricingsService.remove(id, user.businessId);
  }
}
