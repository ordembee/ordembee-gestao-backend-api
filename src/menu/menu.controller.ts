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
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MenuService } from './menu.service';
import { BusinessService } from '../business/business.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { UpdateMenuSettingsDto } from './dto/update-menu-settings.dto';
import {
  ReorderMenuCategoriesDto,
  UpdateMenuItemDto,
} from './dto/menu-items.dto';
import { SaveOptionGroupDto } from './dto/option-group.dto';
import { ParseObjectIdPipe } from './parse-object-id.pipe';
import { ParseStoreImageKindPipe } from './parse-store-image-kind.pipe';

/** Gestao do cardapio digital — mesma permissao de editar produtos. */
@Controller('menu')
@Roles(Role.OWNER, Role.GERENTE)
export class MenuController {
  constructor(
    private readonly menuService: MenuService,
    private readonly businessService: BusinessService,
  ) {}

  private async assertCanEdit(user: any): Promise<void> {
    if (user.role === Role.GERENTE) {
      const perms = await this.businessService.getEffectivePermissions(
        user.businessId,
        user.role,
      );
      if (!perms.canEditProducts) {
        throw new ForbiddenException('Sem permissão para gerenciar o cardápio');
      }
    }
  }

  @Get('settings')
  getSettings(@CurrentUser() user: any) {
    return this.menuService.getSettings(user.businessId);
  }

  @Patch('settings')
  async updateSettings(
    @CurrentUser() user: any,
    @Body() dto: UpdateMenuSettingsDto,
  ) {
    await this.assertCanEdit(user);
    return this.menuService.updateSettings(user.businessId, dto);
  }

  @Get('preview')
  preview(@CurrentUser() user: any) {
    return this.menuService.preview(user.businessId);
  }

  @Post('publish')
  async publish(@CurrentUser() user: any) {
    await this.assertCanEdit(user);
    return this.menuService.publish(user.businessId);
  }

  @Get('categories')
  listCategories(@CurrentUser() user: any) {
    return this.menuService.listCategories(user.businessId);
  }

  @Put('categories/order')
  async reorderCategories(
    @CurrentUser() user: any,
    @Body() dto: ReorderMenuCategoriesDto,
  ) {
    await this.assertCanEdit(user);
    return this.menuService.reorderCategories(user.businessId, dto);
  }

  @Get('items')
  listItems(@CurrentUser() user: any) {
    return this.menuService.listItems(user.businessId);
  }

  @Patch('items/:productId')
  async updateItem(
    @CurrentUser() user: any,
    @Param('productId', ParseObjectIdPipe) productId: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    await this.assertCanEdit(user);
    return this.menuService.updateItem(user.businessId, productId, dto);
  }

  @Get('option-groups')
  listOptionGroups(@CurrentUser() user: any) {
    return this.menuService.listOptionGroups(user.businessId);
  }

  @Post('option-groups')
  async createOptionGroup(
    @CurrentUser() user: any,
    @Body() dto: SaveOptionGroupDto,
  ) {
    await this.assertCanEdit(user);
    return this.menuService.saveOptionGroup(user.businessId, null, dto);
  }

  @Put('option-groups/:groupId')
  async updateOptionGroup(
    @CurrentUser() user: any,
    @Param('groupId', ParseObjectIdPipe) groupId: string,
    @Body() dto: SaveOptionGroupDto,
  ) {
    await this.assertCanEdit(user);
    return this.menuService.saveOptionGroup(user.businessId, groupId, dto);
  }

  @Delete('option-groups/:groupId')
  async removeOptionGroup(
    @CurrentUser() user: any,
    @Param('groupId', ParseObjectIdPipe) groupId: string,
  ) {
    await this.assertCanEdit(user);
    return this.menuService.removeOptionGroup(user.businessId, groupId);
  }

  /** Envio da logo ou da capa (`kind` = logo | cover), campo multipart `image`. */
  @Post('images/:kind')
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
    @Param('kind', ParseStoreImageKindPipe) kind: 'logo' | 'cover',
    @UploadedFile() file: Express.Multer.File,
  ) {
    await this.assertCanEdit(user);
    return this.menuService.setStoreImage(user.businessId, kind, file);
  }

  @Delete('images/:kind')
  async removeImage(
    @CurrentUser() user: any,
    @Param('kind', ParseStoreImageKindPipe) kind: 'logo' | 'cover',
  ) {
    await this.assertCanEdit(user);
    return this.menuService.removeStoreImage(user.businessId, kind);
  }
}
