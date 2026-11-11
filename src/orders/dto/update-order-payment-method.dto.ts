import { IsEnum } from 'class-validator';
import { PaymentMethod } from '../../common/enums/payment-method.enum';

/** Troca a forma de um pagamento ja registrado (valor e data nao mudam). */
export class UpdateOrderPaymentMethodDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;
}
