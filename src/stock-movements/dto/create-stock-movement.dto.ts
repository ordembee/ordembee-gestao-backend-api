import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { MovementType } from '../schemas/stock-movement.schema';

const MANUAL_TYPES = [
  MovementType.ENTRADA,
  MovementType.SAIDA,
  MovementType.DESPERDICIO,
  MovementType.AJUSTE,
] as const;

export type ManualMovementType = (typeof MANUAL_TYPES)[number];

export class CreateStockMovementDto {
  @IsNotEmpty()
  @IsString()
  productId: string;

  @IsEnum(MANUAL_TYPES)
  type: ManualMovementType;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsNotEmpty()
  @IsString()
  reason: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  newStock?: number;
}
