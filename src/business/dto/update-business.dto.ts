import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { ValidatorConstraintInterface } from 'class-validator';
import { isValidTimeZone } from '../../common/date/timezone.util';
import { isValidCpfOrCnpj } from '../../common/document/cpf-cnpj';
import { PHONE_PATTERN } from '../../customers/dto/create-customer.dto';
import { StructuredAddressDto } from '../../delivery/dto/delivery.dto';

@ValidatorConstraint({ name: 'isCpfOrCnpj', async: false })
class IsCpfOrCnpj implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidCpfOrCnpj(value);
  }
  defaultMessage(): string {
    return 'CPF/CNPJ inválido';
  }
}

@ValidatorConstraint({ name: 'isIanaTimeZone', async: false })
class IsIanaTimeZone implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value === undefined || isValidTimeZone(value);
  }
  defaultMessage(): string {
    return 'timezone deve ser um identificador IANA valido (ex.: America/Sao_Paulo)';
  }
}

export class UpdateBusinessDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  businessType?: string;

  @IsOptional()
  @IsString()
  @Validate(IsIanaTimeZone)
  timezone?: string;

  /** CPF ou CNPJ; string vazia apaga. */
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @Validate(IsCpfOrCnpj)
  document?: string;

  /** Telefone com DDD; string vazia apaga. */
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @Matches(PHONE_PATTERN, {
    message: 'Telefone inválido: use só números, com DDD',
  })
  phone?: string;

  /** E-mail da loja; string vazia apaga. */
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsEmail({}, { message: 'E-mail inválido' })
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => StructuredAddressDto)
  address?: StructuredAddressDto;
}
