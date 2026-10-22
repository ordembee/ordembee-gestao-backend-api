import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../guards/firebase-auth.guard';
import { InternalSignatureGuard } from '../guards/internal-signature.guard';

/**
 * Rota servico-a-servico: dispensa o token do Firebase, mas SEMPRE exige a
 * assinatura HMAC (`InternalSignatureGuard`). Os dois vem juntos aqui para que
 * nao exista rota "publica por engano".
 */
export const InternalRoute = () =>
  applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, true),
    UseGuards(InternalSignatureGuard),
  );
