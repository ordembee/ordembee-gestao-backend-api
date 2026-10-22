import { BadRequestException, PipeTransform } from '@nestjs/common';
import { Types } from 'mongoose';

/** Recusa ids que nao sao ObjectId antes de chegar ao Mongo (evita CastError -> 500). */
export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!Types.ObjectId.isValid(value))
      throw new BadRequestException('Id inválido');
    return value;
  }
}
