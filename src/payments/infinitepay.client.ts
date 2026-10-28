import { Injectable, Logger } from '@nestjs/common';

/**
 * Cliente HTTP do checkout da InfinitePay. So fala com a API — quem decide o
 * que cobrar e o `InfinitePayService`. A API nao tem autenticacao: o link e a
 * consulta vao identificados pela InfiniteTag da loja (`handle`).
 *
 * Referencia: https://www.infinitepay.io/checkout-documentacao
 * `INFINITEPAY_API_BASE_URL` existe so para testes locais contra um mock.
 */
export const INFINITEPAY_TIMEOUT_MS = 10_000;

export interface InfinitePayLinkRequest {
  handle: string;
  /** `price` em centavos. */
  items: { quantity: number; price: number; description: string }[];
  order_nsu: string;
  redirect_url?: string;
  webhook_url?: string;
  customer?: { name?: string; email?: string; phone_number?: string };
  address?: {
    cep: string;
    street: string;
    neighborhood: string;
    number: string;
    complement?: string;
  };
}

export interface InfinitePayCheckRequest {
  handle: string;
  order_nsu: string;
  transaction_nsu?: string;
  slug?: string;
}

export interface InfinitePayCheckResponse {
  success?: boolean;
  paid?: boolean;
  /** Centavos do pedido. */
  amount?: number;
  /** Centavos cobrados (pode incluir juros do parcelamento). */
  paid_amount?: number;
  installments?: number;
  capture_method?: string;
}

export class InfinitePayApiError extends Error {
  constructor(
    readonly status: number,
    /** Codigo da API (ex.: external_checkout_not_enabled) quando houver. */
    readonly code?: string,
    message?: string,
  ) {
    super(message ?? `InfinitePay HTTP ${status}`);
  }
}

@Injectable()
export class InfinitePayClient {
  private readonly logger = new Logger(InfinitePayClient.name);

  private get base(): string {
    return (
      process.env.INFINITEPAY_API_BASE_URL?.replace(/\/+$/, '') ||
      'https://api.checkout.infinitepay.io'
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(INFINITEPAY_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn(
        `InfinitePay ${path}: ${(error as { name?: string })?.name ?? 'erro de rede'}`,
      );
      throw new InfinitePayApiError(0, 'network');
    }
    const json = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!res.ok) {
      const code = typeof json?.error === 'string' ? json.error : undefined;
      this.logger.warn(`InfinitePay ${path}: HTTP ${res.status} ${code ?? ''}`);
      throw new InfinitePayApiError(
        res.status,
        code,
        typeof json?.message === 'string' ? json.message : undefined,
      );
    }
    return json as T;
  }

  /** Devolve o corpo cru: a doc nao diz em qual chave vem a URL (ver `parseLinkUrl`). */
  createLink(req: InfinitePayLinkRequest): Promise<unknown> {
    return this.post('/links', req);
  }

  paymentCheck(
    req: InfinitePayCheckRequest,
  ): Promise<InfinitePayCheckResponse> {
    return this.post('/payment_check', req);
  }
}
