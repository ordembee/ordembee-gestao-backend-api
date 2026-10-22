import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class OptionDto {
  /** Ausente = opcao nova. Presente = mantem o id (pedidos e itens continuam apontando para ela). */
  @IsOptional()
  @IsMongoId()
  id?: string;

  @IsString()
  @Length(1, 80)
  name: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** Cria ou substitui um grupo de complementos inteiro (nome, regras e opcoes). */
export class SaveOptionGroupDto {
  @IsString()
  @Length(1, 80)
  name: string;

  /** 0 = opcional; >= 1 = obrigatorio escolher pelo menos `min`. */
  @IsInt()
  @Min(0)
  @Max(20)
  min: number;

  @IsInt()
  @Min(1)
  @Max(20)
  max: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OptionDto)
  options: OptionDto[];
}
