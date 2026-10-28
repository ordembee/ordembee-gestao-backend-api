import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsMongoId,
  IsOptional,
} from 'class-validator';

/** Edicao de uma linha da lista "O que vai ao ar" (o preco e o do produto, nao se edita aqui). */
export class UpdateMenuItemDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** Grupos de complementos do item, na ordem de exibicao. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsMongoId({ each: true })
  optionGroupIds?: string[];
}

/** Ordem das categorias no cardapio, como o operador arrastou (primeiro = topo). */
export class ReorderMenuCategoriesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  categoryIds: string[];
}
