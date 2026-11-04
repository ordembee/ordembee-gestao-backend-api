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
import { OwnDeliveryService } from '../delivery/own-delivery.service';
import { DeliveryOriginDto } from '../delivery/dto/delivery.dto';
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

/**
 * Gestao do cardapio digital — mesma permissao de editar produtos. O CAIXA so entra pelas
 * permissoes proprias: publicar o cardapio e ativar/desativar itens (leituras liberadas
 * a quem tiver uma das duas, para a aba funcionar).
 */
@Controller('menu')
@Roles(Role.OWNER, Role.GERENTE, Role.CAIXA)
export class MenuController {
  constructor(
    private readonly menuService: MenuService,
    private readonly businessService: BusinessService,
    private readonly ownDelivery: OwnDeliveryService,
  ) {}

  private async assertAllowed(
    user: any,
    action: 'read' | 'edit' | 'publish' | 'toggle',
  ): Promise<void> {
    if (user.role === Role.OWNER) return;
    const perms = await this.businessService.getEffectivePermissions(
      user.businessId,
      user.role,
    );
    if (user.role === Role.GERENTE) {
      if (action !== 'read' && !perms.canEditProducts) {
        throw new ForbiddenException('Sem permissão para gerenciar o cardápio');
      }
      return;
    }
    // CAIXA: nunca edita a configuracao; so o que a permissao dele libera.
    const allowed =
      action === 'publish'
        ? perms.canPublishMenu
        : action === 'toggle'
          ? perms.canToggleMenuItems
          : action === 'read'
            ? perms.canPublishMenu || perms.canToggleMenuItems
            : false;
    if (!allowed) {
      throw new ForbiddenException('Sem permissão para gerenciar o cardápio');
    }
  }

  @Get('settings')
  async getSettings(@CurrentUser() user: any) {
    await this.assertAllowed(user, 'read');
    return this.menuService.getSettings(user.businessId);
  }

  @Patch('settings')
  async updateSettings(
    @CurrentUser() user: any,
    @Body() dto: UpdateMenuSettingsDto,
  ) {
    await this.assertAllowed(user, 'edit');
    return this.menuService.updateSettings(user.businessId, dto);
  }

  /** Define de onde saem as entregas (endereço da loja ou outro informado). */
  @Post('delivery-origin')
  async setDeliveryOrigin(
    @CurrentUser() user: any,
    @Body() dto: DeliveryOriginDto,
  ) {
    await this.assertAllowed(user, 'edit');
    return this.ownDelivery.setOrigin(user.businessId, dto.address);
  }

  @Get('preview')
  async preview(@CurrentUser() user: any) {
    await this.assertAllowed(user, 'read');
    return this.menuService.preview(user.businessId);
  }

  @Post('publish')
  async publish(@CurrentUser() user: any) {
    await this.assertAllowed(user, 'publish');
    return this.menuService.publish(user.businessId);
  }

  @Get('categories')
  async listCategories(@CurrentUser() user: any) {
    await this.assertAllowed(user, 'read');
    return this.menuService.listCategories(user.businessId);
  }

  @Put('categories/order')
  async reorderCategories(
    @CurrentUser() user: any,
    @Body() dto: ReorderMenuCategoriesDto,
  ) {
    await this.assertAllowed(user, 'edit');
    return this.menuService.reorderCategories(user.businessId, dto);
  }

  @Get('items')
  async listItems(@CurrentUser() user: any) {
    await this.assertAllowed(user, 'read');
    return this.menuService.listItems(user.businessId);
  }

  @Patch('items/:productId')
  async updateItem(
    @CurrentUser() user: any,
    @Param('productId', ParseObjectIdPipe) productId: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    await this.assertAllowed(user, 'toggle');
    // CAIXA so liga/desliga o item; complementos sao configuracao.
    if (user.role === Role.CAIXA && dto.optionGroupIds !== undefined) {
      throw new ForbiddenException('Sem permissão para editar complementos');
    }
    return this.menuService.updateItem(user.businessId, productId, dto);
  }

  @Get('option-groups')
  async listOptionGroups(@CurrentUser() user: any) {
    await this.assertAllowed(user, 'read');
    return this.menuService.listOptionGroups(user.businessId);
  }

  @Post('option-groups')
  async createOptionGroup(
    @CurrentUser() user: any,
    @Body() dto: SaveOptionGroupDto,
  ) {
    await this.assertAllowed(user, 'edit');
    return this.menuService.saveOptionGroup(user.businessId, null, dto);
  }

  @Put('option-groups/:groupId')
  async updateOptionGroup(
    @CurrentUser() user: any,
    @Param('groupId', ParseObjectIdPipe) groupId: string,
    @Body() dto: SaveOptionGroupDto,
  ) {
    await this.assertAllowed(user, 'edit');
    return this.menuService.saveOptionGroup(user.businessId, groupId, dto);
  }

  @Delete('option-groups/:groupId')
  async removeOptionGroup(
    @CurrentUser() user: any,
    @Param('groupId', ParseObjectIdPipe) groupId: string,
  ) {
    await this.assertAllowed(user, 'edit');
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
    await this.assertAllowed(user, 'edit');
    return this.menuService.setStoreImage(user.businessId, kind, file);
  }

  @Delete('images/:kind')
  async removeImage(
    @CurrentUser() user: any,
    @Param('kind', ParseStoreImageKindPipe) kind: 'logo' | 'cover',
  ) {
    await this.assertAllowed(user, 'edit');
    return this.menuService.removeStoreImage(user.businessId, kind);
  }
}
