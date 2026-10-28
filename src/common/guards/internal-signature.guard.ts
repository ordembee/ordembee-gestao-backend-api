import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/** Janela aceita entre o relogio de quem assina e o nosso. */
export const INTERNAL_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

/** Segredo curto demais e quebravel por forca bruta: a rota interna fica fechada. */
export const INTERNAL_SECRET_MIN_LENGTH = 32;

/** `hex(HMAC-SHA256(secret, "${timestamp}.${rawBody}"))` — mesmo calculo do ordembee-cardapio-web-backend-api. */
export function signInternalRequest(
  secret: string,
  timestamp: string,
  rawBody: string | Buffer,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

/**
 * O que um GET assina no lugar do corpo: "GET /internal/...". Amarra a
 * assinatura a rota e aos parametros (ex.: o slug), para uma assinatura
 * capturada nao servir em outra URL. O caminho e cortado a partir de
 * `/internal/` porque o prefixo muda entre local (/api/v1) e Firebase.
 */
export function internalGetSigningPayload(method: string, url: string): string {
  const path = String(url ?? '').split('?')[0];
  const at = path.indexOf('/internal/');
  return `${method.toUpperCase()} ${at >= 0 ? path.slice(at) : path}`;
}

/**
 * O que e assinado depois de "ts.":
 * - GET:  "GET /internal/menus/x/live"
 * - POST: "POST /internal/menu-orders\n" + corpo cru
 * Metodo e rota entram nos dois casos: uma assinatura capturada nao serve
 * para outra rota interna.
 */
export function internalSigningPayload(
  method: string,
  url: string,
  rawBody?: Buffer,
): Buffer | undefined {
  const line = internalGetSigningPayload(method, url);
  if (method.toUpperCase() === 'GET') return Buffer.from(line);
  if (!rawBody) return undefined;
  return Buffer.concat([Buffer.from(`${line}\n`), rawBody]);
}

/**
 * Autentica chamadas servico-a-servico (hoje: ordembee-cardapio-web-backend-api -> backend-api).
 * Exige `X-Internal-Timestamp` (epoch ms) e `X-Internal-Signature` calculada
 * sobre o corpo CRU — por isso o app precisa de `rawBody` (ver main.ts/firebase.ts).
 * Sem `INTERNAL_API_SECRET` configurado, tudo e recusado.
 */
@Injectable()
export class InternalSignatureGuard implements CanActivate {
  private readonly logger = new Logger(InternalSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const secret = this.config.get<string>('INTERNAL_API_SECRET');
    const deny = (reason: string): never => {
      this.logger.warn(
        `Chamada interna recusada (${reason}): ${request.method} ${request.url}`,
      );
      throw new UnauthorizedException('Não autorizado');
    };

    if (!secret || secret.length < INTERNAL_SECRET_MIN_LENGTH) {
      this.logger.error(
        `INTERNAL_API_SECRET ausente ou com menos de ${INTERNAL_SECRET_MIN_LENGTH} caracteres — rota interna bloqueada`,
      );
      return deny('segredo inválido');
    }

    const timestamp = String(request.headers['x-internal-timestamp'] ?? '');
    const signature = String(request.headers['x-internal-signature'] ?? '');
    const rawBody = internalSigningPayload(
      String(request.method ?? ''),
      request.originalUrl ?? request.url,
      request.rawBody,
    );
    if (
      !/^\d{13}$/.test(timestamp) ||
      !/^[0-9a-f]{64}$/.test(signature) ||
      !rawBody
    ) {
      return deny('cabeçalhos ausentes');
    }
    if (
      Math.abs(Date.now() - Number(timestamp)) > INTERNAL_SIGNATURE_MAX_SKEW_MS
    ) {
      return deny('timestamp fora da janela');
    }

    const expected = Buffer.from(
      signInternalRequest(secret, timestamp, rawBody),
      'hex',
    );
    const received = Buffer.from(signature, 'hex');
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      return deny('assinatura inválida');
    }
    return true;
  }
}
