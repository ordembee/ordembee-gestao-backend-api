import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsEmail,
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
 * Tetos do pedido do cardapio (mesmos valores do ordembee-cardapio-web-backend-api): ate 10
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

  /** Opcional: vai para o checkout da InfinitePay. */
  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  email?: string;
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

  /** Cidade e UF: obrigatorios na entrega pela Uber (validado no servico). */
  @IsOptional()
  @IsString()
  @Length(2, 80)
  city?: string;

  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/)
  state?: string;

  /** "Tocar o interfone 203", "Deixar na portaria". */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  instructions?: string;
}

/** Quem recebe a entrega (pode nao ser quem pediu). */
class MenuOrderRecipientDto {
  @IsString()
  @Length(3, 80)
  name: string;

  @Matches(/^\d{10,11}$/, { message: 'phone deve ter 10 ou 11 dígitos' })
  phone: string;
}

class MenuOrderPaymentDto {
  @IsIn(MENU_PAYMENT_METHODS)
  method: (typeof MENU_PAYMENT_METHODS)[number];

  // Bandeira opcional no cartão (retirada não pergunta); quando vem, precisa ser conhecida.
  @ValidateIf(
    (p: MenuOrderPaymentDto) =>
      (p.method === PaymentMethod.CARTAO_CREDITO ||
        p.method === PaymentMethod.CARTAO_DEBITO) &&
      p.brand !== undefined,
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

/** Contrato da rota interna `POST /internal/menu-orders` (enviado pelo ordembee-cardapio-web-backend-api). */
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

  @IsOptional()
  @ValidateNested()
  @Type(() => MenuOrderRecipientDto)
  recipient?: MenuOrderRecipientDto;

  /** Cotacao da Uber mostrada no checkout (entrega pela Uber). */
  @IsOptional()
  @IsString()
  @Length(3, 120)
  quoteId?: string;

  @ValidateNested()
  @Type(() => MenuOrderPaymentDto)
  payment: MenuOrderPaymentDto;

  /** Pagina do cardapio para onde a InfinitePay devolve o cliente depois de pagar. */
  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\/\S{3,480}$/, { message: 'redirectUrl inválida' })
  redirectUrl?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ITEMS_PER_ORDER)
  @ValidateNested({ each: true })
  @Type(() => MenuOrderItemDto)
  items: MenuOrderItemDto[];
}
