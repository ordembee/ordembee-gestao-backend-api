import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PHONE_PATTERN } from '../../customers/dto/create-customer.dto';
import { StructuredAddressDto } from '../../delivery/dto/delivery.dto';

export class RegisterBusinessDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  businessType?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'Telefone inválido' })
  phone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => StructuredAddressDto)
  address?: StructuredAddressDto;
}
