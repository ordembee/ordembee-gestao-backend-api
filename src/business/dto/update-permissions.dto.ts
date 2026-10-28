import {
  IsBoolean,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class GerentePermissionsDto {
  @IsBoolean() @IsOptional() canViewSales?: boolean;
  @IsBoolean() @IsOptional() canCancelSales?: boolean;
  @IsBoolean() @IsOptional() canApplyDiscounts?: boolean;
  @IsBoolean() @IsOptional() canEditProducts?: boolean;
  @IsBoolean() @IsOptional() canChangePrices?: boolean;
  @IsBoolean() @IsOptional() canManageStock?: boolean;
  @IsBoolean() @IsOptional() canViewFinancialReports?: boolean;
  @IsBoolean() @IsOptional() canManageUsers?: boolean;
}

class CaixaPermissionsDto {
  @IsBoolean() @IsOptional() canViewProducts?: boolean;
  @IsBoolean() @IsOptional() canViewCategories?: boolean;
  @IsBoolean() @IsOptional() canApplyDiscounts?: boolean;
  @IsBoolean() @IsOptional() canCancelSales?: boolean;
  @IsBoolean() @IsOptional() canRefund?: boolean;
  @IsBoolean() @IsOptional() canSellWithNegativeStock?: boolean;
  @IsBoolean() @IsOptional() canViewStock?: boolean;
}

export class UpdatePermissionsDto {
  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => GerentePermissionsDto)
  gerente?: GerentePermissionsDto;

  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => CaixaPermissionsDto)
  caixa?: CaixaPermissionsDto;
}
