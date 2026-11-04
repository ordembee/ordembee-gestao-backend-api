import { ForbiddenException } from '@nestjs/common';
import { MenuController } from './menu.controller';
import { Role } from '../common/enums/role.enum';
import { DEFAULT_PERMISSIONS } from '../business/schemas/business.schema';

/** Quem pode o que na gestao do cardapio: o CAIXA so entra pelas permissoes proprias. */
describe('MenuController — permissoes', () => {
  const menuService = {
    getSettings: jest.fn().mockResolvedValue({ ok: true }),
    publish: jest.fn().mockResolvedValue({ version: 2 }),
    updateItem: jest.fn().mockResolvedValue({ ok: true }),
    reorderCategories: jest.fn(),
  };
  let perms: Record<string, boolean>;
  const businessService = {
    getEffectivePermissions: jest.fn(async () => perms),
  };
  const controller = new MenuController(
    menuService as any,
    businessService as any,
    {} as any,
  );
  const caixa = { role: Role.CAIXA, businessId: 'b1' };
  const gerente = { role: Role.GERENTE, businessId: 'b1' };

  beforeEach(() => {
    jest.clearAllMocks();
    perms = { ...DEFAULT_PERMISSIONS.caixa, canEditProducts: true };
  });

  it('caixa sem permissao nao le, publica nem liga item', async () => {
    await expect(controller.getSettings(caixa)).rejects.toThrow(ForbiddenException);
    await expect(controller.publish(caixa)).rejects.toThrow(ForbiddenException);
    await expect(
      controller.updateItem(caixa, 'p1', { active: true }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('caixa com canPublishMenu publica, mas nao liga item', async () => {
    perms.canPublishMenu = true;
    await expect(controller.publish(caixa)).resolves.toEqual({ version: 2 });
    await expect(controller.getSettings(caixa)).resolves.toBeDefined();
    await expect(
      controller.updateItem(caixa, 'p1', { active: true }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('caixa com canToggleMenuItems liga item, mas so o "active"', async () => {
    perms.canToggleMenuItems = true;
    await controller.updateItem(caixa, 'p1', { active: false });
    expect(menuService.updateItem).toHaveBeenCalled();
    await expect(
      controller.updateItem(caixa, 'p1', { optionGroupIds: [] }),
    ).rejects.toThrow(ForbiddenException);
    await expect(controller.publish(caixa)).rejects.toThrow(ForbiddenException);
  });

  it('caixa nunca edita configuracao, mesmo com as duas permissoes', async () => {
    perms.canPublishMenu = true;
    perms.canToggleMenuItems = true;
    await expect(
      controller.reorderCategories(caixa, { categoryIds: [] }),
    ).rejects.toThrow(ForbiddenException);
    expect(menuService.reorderCategories).not.toHaveBeenCalled();
  });

  it('gerente continua dependendo de canEditProducts', async () => {
    await expect(controller.publish(gerente)).resolves.toBeDefined();
    perms.canEditProducts = false;
    await expect(controller.publish(gerente)).rejects.toThrow(ForbiddenException);
    await expect(controller.getSettings(gerente)).resolves.toBeDefined();
  });
});
