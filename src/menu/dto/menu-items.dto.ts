import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Edicao de uma linha da lista "O que vai ao ar" (o preco e o do produto, nao se edita aqui). */
export class UpdateMenuItemDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  tag?: string;

  /** Grupos de complementos do item, na ordem de exibicao. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsMongoId({ each: true })
  optionGroupIds?: string[];
}

/** Ordem completa da lista, como o operador arrastou (primeiro = topo). */
export class ReorderMenuItemsDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @IsMongoId({ each: true })
  productIds: string[];
}
