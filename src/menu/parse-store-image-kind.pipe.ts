import { BadRequestException, PipeTransform } from '@nestjs/common';

/** So aceita as imagens que a loja tem: logo e capa. */
export class ParseStoreImageKindPipe implements PipeTransform<
  string,
  'logo' | 'cover'
> {
  transform(value: string): 'logo' | 'cover' {
    if (value !== 'logo' && value !== 'cover') {
      throw new BadRequestException('Imagem inválida (use logo ou cover)');
    }
    return value;
  }
}
