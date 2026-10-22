import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderFulfillment } from '../../orders/schemas/order.schema';
import { PaymentMethod } from '../../common/enums/payment-method.enum';
import { MENU_SLUG_PATTERN } from './update-menu-settings.dto';

/**
 * Tetos do pedido do cardapio (mesmos valores do my-store-cardapio-web-back-api): ate 10
 * unidades de cada produto, somando as linhas, e ate 20 itens no total.
 */
export const MAX_UNITS_PER_PRODUCT = 10;
export const MAX_ITEMS_PER_ORDER = 20;

/** Formas aceitas pelo cardapio — todas pagas na entrega/retirada. */
export const MENU_PAYMENT_METHODS = [
  PaymentMethod.CARTAO_CREDITO,
  PaymentMethod.CARTAO_DEBITO,
  PaymentMethod.PIX,
  PaymentMethod.DINHEIRO,
] as const;

export const CARD_BRANDS = ['visa', 'master', 'elo', 'amex', 'hiper'] as const;

class MenuOrderCustomerDto {
  @IsString()
  @Length(3, 80)
  name: string;

  @Matches(/^\d{10,11}$/, { message: 'phone deve ter 10 ou 11 dígitos' })
  phone: string;
}

class MenuOrderAddressDto {
  @IsOptional()
  @Matches(/^\d{5}-?\d{3}$/)
  cep?: string;

  @IsString()
  @Length(2, 120)
  street: string;

  @IsString()
  @Length(1, 20)
  number: string;

  @IsString()
  @Length(2, 80)
  district: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  complement?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

class MenuOrderPaymentDto {
  @IsIn(MENU_PAYMENT_METHODS)
  method: (typeof MENU_PAYMENT_METHODS)[number];

  @ValidateIf(
    (p: MenuOrderPaymentDto) =>
      p.method === PaymentMethod.CARTAO_CREDITO ||
      p.method === PaymentMethod.CARTAO_DEBITO,
  )
  @IsIn(CARD_BRANDS)
  brand?: (typeof CARD_BRANDS)[number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  changeFor?: number;
}

class MenuOrderItemOptionDto {
  @IsMongoId()
  groupId: string;

  @IsMongoId()
  optionId: string;
}

class MenuOrderItemDto {
  @IsMongoId()
  productId: string;

  /** Complementos marcados (uma vez cada). Validados contra os grupos do item. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => MenuOrderItemOptionDto)
  options?: MenuOrderItemOptionDto[];

  @IsInt()
  @Min(1)
  @Max(MAX_UNITS_PER_PRODUCT)
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  notes?: string;
}

/** Contrato da rota interna `POST /internal/menu-orders` (enviado pelo my-store-cardapio-web-back-api). */
export class MenuOrderDto {
  @Matches(MENU_SLUG_PATTERN)
  slug: string;

  @IsUUID()
  orderRef: string;

  @ValidateNested()
  @Type(() => MenuOrderCustomerDto)
  customer: MenuOrderCustomerDto;

  @IsEnum(OrderFulfillment)
  fulfillment: OrderFulfillment;

  @ValidateIf((o: MenuOrderDto) => o.fulfillment === OrderFulfillment.ENTREGA)
  @IsDefined({ message: 'address é obrigatório para entrega' })
  @ValidateNested()
  @Type(() => MenuOrderAddressDto)
  address?: MenuOrderAddressDto;

  @ValidateNested()
  @Type(() => MenuOrderPaymentDto)
  payment: MenuOrderPaymentDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ITEMS_PER_ORDER)
  @ValidateNested({ each: true })
  @Type(() => MenuOrderItemDto)
  items: MenuOrderItemDto[];
}
