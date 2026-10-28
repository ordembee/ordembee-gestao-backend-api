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
  ValidateNested,
  ValidatorConstraint,
} from 'class-validator';
import type { ValidatorConstraintInterface } from 'class-validator';
import { Type } from 'class-transformer';
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

/** Slug do cardapio: so a-z, 0-9 e hifen (nao nas pontas), ate 50 posicoes. */
export const MENU_SLUG_MAX = 50;
export const MENU_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

/** O provedor da entrega se troca em delivery-settings (so o dono: depende das credenciais). */
export class UpdateMenuDeliveryDto {
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
}

export class UpdateMenuContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @Matches(/^(\d{10,13})?$/, {
    message: 'whatsapp deve ter só dígitos, com DDD',
  })
  whatsapp?: string;
}

export class UpdateMenuSocialMediaDto {
  @IsOptional()
  @Matches(/^@?[A-Za-z0-9._]{0,30}$/, {
    message: 'instagram inválido (ex.: @minhaloja)',
  })
  instagram?: string;
}

export class UpdateMenuColorsDto {
  /** Cor da marca no cardapio. Vazio = volta para a cor padrao. */
  @IsOptional()
  @Matches(/^(#[0-9a-fA-F]{6})?$/, { message: 'cor inválida (use #RRGGBB)' })
  themeColor?: string;
}

/** Imagens se trocam por upload (POST /menu/images/:kind); aqui so a URL colada da capa. */
export class UpdateMenuImagesDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverUrl?: string;
}

export class UpdateMenuStoreDto {
  /** Formas de pagamento aceitas no cardápio. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Aceite pelo menos uma forma de pagamento' })
  @IsIn(['CARTAO_CREDITO', 'CARTAO_DEBITO', 'PIX', 'DINHEIRO'], { each: true })
  acceptedPayments?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateMenuDeliveryDto)
  delivery?: UpdateMenuDeliveryDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateMenuContactDto)
  contact?: UpdateMenuContactDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateMenuSocialMediaDto)
  socialMedia?: UpdateMenuSocialMediaDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateMenuImagesDto)
  images?: UpdateMenuImagesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateMenuColorsDto)
  colors?: UpdateMenuColorsDto;

  @IsOptional()
  @IsObject()
  @Validate(IsOpeningHours)
  openingHours?: Record<string, [string, string] | null>;
}

export class UpdateMenuLabelTextDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  /** Frase de destaque: linha pequena acima do título. Vazio = não aparece. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  highlightLabel?: string;

  /** Frase de destaque: título acima das categorias. Vazio = não aparece. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  highlightTitle?: string;
}

/** PATCH /menu/settings — mesmo formato do documento MenuOnline, tudo opcional. */
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
  @ValidateNested()
  @Type(() => UpdateMenuStoreDto)
  store?: UpdateMenuStoreDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateMenuLabelTextDto)
  labelText?: UpdateMenuLabelTextDto;
}
