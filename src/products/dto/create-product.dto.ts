import {
  IsArray,
  IsBoolean,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class ComboItemDto {
  @IsString()
  @IsNotEmpty()
  productId: string;

  @IsNumber()
  @Min(1)
  quantity: number;

  @IsString()
  @IsNotEmpty()
  productName: string;
}

class ChannelPriceDto {
  @IsNumber()
  @Min(0)
  value: number;

  @IsBoolean()
  active: boolean;
}

class ProductPricesDto {
  @ValidateNested()
  @Type(() => ChannelPriceDto)
  caixa: ChannelPriceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelPriceDto)
  ifood?: ChannelPriceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelPriceDto)
  food99?: ChannelPriceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelPriceDto)
  deliveryProprio?: ChannelPriceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelPriceDto)
  ordemBee?: ChannelPriceDto;
}

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @ValidateNested()
  @Type(() => ProductPricesDto)
  prices: ProductPricesDto;

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
  isCombo?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComboItemDto)
  comboItems?: ComboItemDto[];

  @IsOptional()
  @IsMongoId()
  pricingId?: string;
}
