import { UnauthorizedException } from '@nestjs/common';
import {
  InternalSignatureGuard,
  internalGetSigningPayload,
  internalSigningPayload,
  signInternalRequest,
} from './internal-signature.guard';

const SECRET = 'segredo-de-teste-com-pelo-menos-32-caracteres';

function contextFor(headers: Record<string, string>, rawBody?: string) {
  const request = {
    method: 'POST',
    url: '/v1/internal/menu-orders',
    headers,
    rawBody: rawBody === undefined ? undefined : Buffer.from(rawBody),
  };
  return { switchToHttp: () => ({ getRequest: () => request }) } as any;
}

const guard = (secret: string | undefined = SECRET) =>
  new InternalSignatureGuard({ get: () => secret } as any);

describe('InternalSignatureGuard', () => {
  const body = '{"slug":"tia-nana"}';

  it('aceita assinatura válida sobre o corpo cru', () => {
    const ts = String(Date.now());
    const ctx = contextFor(
      {
        'x-internal-timestamp': ts,
        'x-internal-signature': signInternalRequest(
          SECRET,
          ts,
          `POST /internal/menu-orders\n${body}`,
        ),
      },
      body,
    );
    expect(guard().canActivate(ctx)).toBe(true);
  });

  it('usa exatamente hex(HMAC-SHA256(secret, "ts.body")) — contrato com o ordembee-cardapio-web-backend-api', () => {
    // Valor fixo: se mudar, o ordembee-cardapio-web-backend-api para de conseguir assinar.
    expect(signInternalRequest('abc', '1700000000000', '{}')).toBe(
      '6f018a0fd0914835a1092a6ffc6346f695b8aaaa8adb787d90388093e76687cf',
    );
  });

  it.each([
    ['sem cabeçalhos', {}, body],
    [
      'assinatura errada',
      {
        'x-internal-timestamp': String(Date.now()),
        'x-internal-signature': 'a'.repeat(64),
      },
      body,
    ],
    [
      'sem rawBody',
      {
        'x-internal-timestamp': String(Date.now()),
        'x-internal-signature': 'a'.repeat(64),
      },
      undefined,
    ],
  ])('recusa %s', (_label, headers, raw) => {
    expect(() => guard().canActivate(contextFor(headers as any, raw))).toThrow(
      UnauthorizedException,
    );
  });

  it('recusa corpo adulterado', () => {
    const ts = String(Date.now());
    const ctx = contextFor(
      {
        'x-internal-timestamp': ts,
        'x-internal-signature': signInternalRequest(
          SECRET,
          ts,
          `POST /internal/menu-orders\n${body}`,
        ),
      },
      '{"slug":"outra-loja"}',
    );
    expect(() => guard().canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('recusa timestamp fora da janela de 5 min', () => {
    const ts = String(Date.now() - 6 * 60 * 1000);
    const ctx = contextFor(
      {
        'x-internal-timestamp': ts,
        'x-internal-signature': signInternalRequest(
          SECRET,
          ts,
          `POST /internal/menu-orders\n${body}`,
        ),
      },
      body,
    );
    expect(() => guard().canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('recusa tudo quando INTERNAL_API_SECRET não está configurado', () => {
    const ts = String(Date.now());
    const ctx = contextFor(
      {
        'x-internal-timestamp': ts,
        'x-internal-signature': signInternalRequest('', ts, body),
      },
      body,
    );
    expect(() => guard(undefined).canActivate(ctx)).toThrow(
      UnauthorizedException,
    );
  });

  describe('GET (sem corpo)', () => {
    const getContext = (url: string, headers: Record<string, string>) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ method: 'GET', url, originalUrl: url, headers }),
        }),
      }) as any;

    it('assina "GET /internal/..." independente do prefixo', () => {
      expect(
        internalGetSigningPayload('get', '/api/v1/internal/menus/tia/live'),
      ).toBe('GET /internal/menus/tia/live');
      expect(
        internalGetSigningPayload('GET', '/v1/internal/menus/tia/live'),
      ).toBe('GET /internal/menus/tia/live');
    });

    it('vetor fixo do contrato GET com o ordembee-cardapio-web-backend-api', () => {
      expect(
        signInternalRequest(
          'abc',
          '1700000000000',
          'GET /internal/menus/tia/live',
        ),
      ).toBe(
        'c9ed8391a493eb9e640948712dffd9d2694bbc225cf5c91c921b1bcda0de4743',
      );
    });

    it('vetor fixo do contrato POST com o ordembee-cardapio-web-backend-api', () => {
      const payload = internalSigningPayload(
        'POST',
        '/api/v1/internal/menu-orders',
        Buffer.from('{}'),
      )!;
      expect(signInternalRequest('abc', '1700000000000', payload)).toBe(
        'd7da8d3c8752f3d4f411089177ab0d31d276db7c81ff3ac26d801f4d72223acb',
      );
    });

    it('aceita GET assinado e recusa a mesma assinatura em outra URL', () => {
      const ts = String(Date.now());
      const sig = signInternalRequest(
        SECRET,
        ts,
        'GET /internal/menus/tia/live',
      );
      const headers = {
        'x-internal-timestamp': ts,
        'x-internal-signature': sig,
      };
      expect(
        guard().canActivate(
          getContext('/api/v1/internal/menus/tia/live', headers),
        ),
      ).toBe(true);
      expect(() =>
        guard().canActivate(
          getContext('/api/v1/internal/menus/outra/live', headers),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  it('POST assina método + rota + corpo: a mesma assinatura não vale em outra rota', () => {
    const ts = String(Date.now());
    const headers = {
      'x-internal-timestamp': ts,
      'x-internal-signature': signInternalRequest(
        SECRET,
        ts,
        `POST /internal/menu-orders\n${body}`,
      ),
    };
    const at = (url: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'POST',
            url,
            originalUrl: url,
            headers,
            rawBody: Buffer.from(body),
          }),
        }),
      }) as any;
    expect(guard().canActivate(at('/api/v1/internal/menu-orders'))).toBe(true);
    expect(() =>
      guard().canActivate(at('/api/v1/internal/outra-rota')),
    ).toThrow(UnauthorizedException);
  });

  it('recusa segredo com menos de 32 caracteres', () => {
    const ts = String(Date.now());
    const ctx = contextFor(
      {
        'x-internal-timestamp': ts,
        'x-internal-signature': signInternalRequest('curto', ts, body),
      },
      body,
    );
    expect(() => guard('curto').canActivate(ctx)).toThrow(
      UnauthorizedException,
    );
  });
});
