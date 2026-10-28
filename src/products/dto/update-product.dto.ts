import {
  IsArray,
  IsBoolean,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class UpdateComboItemDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsString()
  productName?: string;
}

class UpdateChannelPriceDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

class UpdatePricesDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateChannelPriceDto)
  caixa?: UpdateChannelPriceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateChannelPriceDto)
  ifood?: UpdateChannelPriceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateChannelPriceDto)
  food99?: UpdateChannelPriceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateChannelPriceDto)
  deliveryProprio?: UpdateChannelPriceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateChannelPriceDto)
  ordemBee?: UpdateChannelPriceDto;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdatePricesDto)
  prices?: UpdatePricesDto;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  costPrice?: number;

  @IsOptional()
  @IsNumber()
  stock?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isCombo?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateComboItemDto)
  comboItems?: UpdateComboItemDto[];

  // `undefined`/campo ausente = não mexer no vínculo; `null` = desvincular;
  // string = vincular/trocar a precificação.
  @IsOptional()
  @IsMongoId()
  pricingId?: string | null;
}
