import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

/** Só números e a pontuação comum (+ ( ) - . espaço), com 10 a 13 dígitos (DDD, e +55 opcional). */
export const PHONE_PATTERN = /^(?=(?:\D*\d){10,13}\D*$)[\d\s()+.-]+$/;
const PHONE_MESSAGE = 'Telefone inválido: use só números, com DDD';

export class CreateCustomerDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone: string;

  @IsOptional()
  @IsString()
  document?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
