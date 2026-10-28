import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DeliveryProvider } from '../../menu/schemas/menu-online.schema';

export const UF_PATTERN = /^[A-Za-z]{2}$/;
export const CEP_PATTERN = /^\d{5}-?\d{3}$/;

/** Endereco estruturado (coleta da loja ou entrega do cliente). */
export class StructuredAddressDto {
  @Matches(CEP_PATTERN, { message: 'CEP inválido' })
  cep: string;

  @IsString()
  @Length(2, 120)
  street: string;

  @IsString()
  @Length(1, 20)
  number: string;

  @IsString()
  @Length(2, 80)
  district: string;

  @IsString()
  @Length(2, 80)
  city: string;

  @Matches(UF_PATTERN, { message: 'UF inválida' })
  state: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  complement?: string;
}

/** `POST /internal/menus/:slug/delivery-quote` (vem do ordembee-cardapio-web-backend-api). */
export class MenuDeliveryQuoteDto {
  @ValidateNested()
  @Type(() => StructuredAddressDto)
  address: StructuredAddressDto;

  /** Valor dos itens (declarado a Uber como valor da carga). */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  subtotal: number;
}

/** `POST /delivery/quote`: cotacao para um pedido digitado no painel. */
export class PanelDeliveryQuoteDto {
  @ValidateNested()
  @Type(() => StructuredAddressDto)
  address: StructuredAddressDto;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  subtotal: number;

  /** Telefone de quem recebe (a Uber usa para contato). */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

export class PixSettingsDto {
  @IsString()
  @Length(3, 77)
  key: string;

  @IsString()
  @Length(2, 25)
  merchantName: string;

  @IsString()
  @Length(2, 15)
  merchantCity: string;
}

export class UberDirectSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  clientId?: string;

  /** Vazio/ausente = mantem o que ja esta gravado. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientSecret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  webhookSigningKey?: string;

  @IsOptional()
  @IsBoolean()
  sandbox?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => StructuredAddressDto)
  pickupAddress?: StructuredAddressDto;

  @IsOptional()
  @Matches(/^(\+?\d{10,13})?$/, { message: 'Telefone com DDD, só números' })
  pickupPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  pickupNotes?: string;
}

/** `PUT /menu/delivery-settings` — so o dono. */
export class UpdateDeliverySettingsDto {
  @IsOptional()
  @IsEnum(DeliveryProvider)
  deliveryProvider?: DeliveryProvider;

  @IsOptional()
  @ValidateNested()
  @Type(() => PixSettingsDto)
  pix?: PixSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UberDirectSettingsDto)
  uberDirect?: UberDirectSettingsDto;
}

/** `POST /orders/:id/uber-delivery` — despacha com a cotacao refeita. */
export class DispatchUberDeliveryDto {
  @IsString()
  @Length(3, 120)
  quoteId: string;

  /** Operador confirmou pagar a diferenca quando o frete subiu. */
  @IsOptional()
  @IsBoolean()
  acceptFeeIncrease?: boolean;
}

/** `POST /internal/menu-orders/:ref/payment-claim`. */
export class MenuPaymentClaimDto {
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/)
  slug: string;
}
