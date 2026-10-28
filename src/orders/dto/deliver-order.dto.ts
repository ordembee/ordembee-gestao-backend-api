import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderPaymentDto } from './create-order.dto';

/**
 * Entrega da encomenda. Os pagamentos aqui sao a QUITACAO do saldo restante.
 * Se ainda sobrar saldo depois deles, o restante vira uma parcela FIADO na
 * venda, entrando no controle de divida do cliente que ja existe.
 */
export class DeliverOrderDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => OrderPaymentDto)
  payments?: OrderPaymentDto[];
}
