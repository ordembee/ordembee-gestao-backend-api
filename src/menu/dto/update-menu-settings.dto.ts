import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
} from 'class-validator';
import type { ValidatorConstraintInterface } from 'class-validator';
import { isValidOpeningHours } from '../menu-hours.util';

@ValidatorConstraint({ name: 'isOpeningHours', async: false })
class IsOpeningHours implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value === undefined || isValidOpeningHours(value);
  }
  defaultMessage(): string {
    return "openingHours deve ter chaves '0'..'6' com ['HH:mm','HH:mm'] ou null";
  }
}

export const MENU_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

export class UpdateMenuSettingsDto {
  @IsOptional()
  @IsString()
  @Matches(MENU_SLUG_PATTERN, {
    message:
      'slug deve ter só letras minúsculas, números e hífens (ex.: tia-nana)',
  })
  slug?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @Matches(/^\d{10,13}$/, { message: 'whatsapp deve ter só dígitos, com DDD' })
  whatsapp?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  deliveryFee?: number;

  @IsOptional()
  @IsBoolean()
  deliveryEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  pickupEnabled?: boolean;

  /** Cor da marca no cardapio. Vazio = volta para a cor padrao. */
  @IsOptional()
  @Matches(/^(#[0-9a-fA-F]{6})?$/, { message: 'cor inválida (use #RRGGBB)' })
  themeColor?: string;

  @IsOptional()
  @Matches(/^@?[A-Za-z0-9._]{0,30}$/, {
    message: 'instagram inválido (ex.: @minhaloja)',
  })
  instagram?: string;

  /** Formas de pagamento aceitas no cardápio. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Aceite pelo menos uma forma de pagamento' })
  @IsIn(['CARTAO_CREDITO', 'CARTAO_DEBITO', 'PIX', 'DINHEIRO'], { each: true })
  acceptedPayments?: string[];

  @IsOptional()
  @IsObject()
  @Validate(IsOpeningHours)
  openingHours?: Record<string, [string, string] | null>;
}
