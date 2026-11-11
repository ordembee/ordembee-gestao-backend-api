import { IsBoolean, IsEnum, IsNumber, IsOptional, Min } from 'class-validator';
import { PaymentMethod } from '../../common/enums/payment-method.enum';

/** Sinal (ou parcela) pago antes da entrega. */
export class AddOrderPaymentDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsNumber()
  @Min(0.01)
  amount: number;

  /**
   * O cliente pagou por fora (dinheiro, maquininha...) um pedido que tinha link
   * da InfinitePay ainda nao pago: descarta o link e registra este pagamento.
   */
  @IsOptional()
  @IsBoolean()
  replaceOnlineLink?: boolean;
}
