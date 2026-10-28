import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProductsService } from './products.service';
import { BusinessService } from '../business/business.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly businessService: BusinessService,
  ) {}

  private async assertCanEdit(user: any): Promise<void> {
    if (user.role === Role.GERENTE) {
      const perms = await this.businessService.getEffectivePermissions(
        user.businessId,
        user.role,
      );
      if (!perms.canEditProducts) {
        throw new ForbiddenException('Sem permissão para editar produtos');
      }
    }
  }

  @Post()
  @Roles(Role.OWNER, Role.GERENTE)
  async create(@CurrentUser() user: any, @Body() dto: CreateProductDto) {
    await this.assertCanEdit(user);
    return this.productsService.create(user.businessId, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: any,
    @Query('search') search?: string,
    @Query('categoryId') categoryId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.productsService.findAll(
      user.businessId,
      search,
      categoryId,
      includeInactive === 'true',
    );
  }

  @Get(':id')
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.productsService.findOne(id, user.businessId);
  }

  @Patch(':id')
  @Roles(Role.OWNER, Role.GERENTE)
  async update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    await this.assertCanEdit(user);
    return this.productsService.update(id, user.businessId, dto);
  }

  @Post(':id/image')
  @Roles(Role.OWNER, Role.GERENTE)
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          return cb(
            new BadRequestException('Apenas imagens são permitidas'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async uploadImage(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    await this.assertCanEdit(user);
    return this.productsService.uploadImage(id, user.businessId, file);
  }

  @Delete(':id')
  @Roles(Role.OWNER, Role.GERENTE)
  async remove(@CurrentUser() user: any, @Param('id') id: string) {
    await this.assertCanEdit(user);
    return this.productsService.remove(id, user.businessId);
  }
}
