import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { PaymentMethod } from '../../common/enums/payment-method.enum';

/** Forma como o cliente vai pagar o que falta (pedido ainda não quitado). */
export class ChoosePaymentMethodDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  /** Bandeira do cartão — só para cartão. */
  @IsOptional()
  @IsString()
  brand?: string;

  /** Troco para quanto — só para dinheiro. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  changeFor?: number;
}
