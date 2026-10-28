import { Injectable, Logger } from '@nestjs/common';

/**
 * Cliente HTTP da Uber Direct (DaaS). So fala com a Uber — quem decide o que
 * pedir e o `UberDirectService`. URLs sobrescreviveis por env para teste local
 * (UBER_AUTH_URL / UBER_API_BASE_URL).
 *
 * Referencia: https://developer.uber.com/docs/deliveries/api-reference/daas
 */

export const UBER_TIMEOUT_MS = 10_000;

export interface UberCredentials {
  customerId: string;
  clientId: string;
  clientSecret: string;
}

/** Endereco no formato que a Uber le (vai como STRING JSON no corpo). */
export interface UberAddress {
  street_address: string[];
  city: string;
  state: string;
  zip_code: string;
  country: 'BR';
}

export interface UberQuoteRequest {
  pickup_address: string;
  dropoff_address: string;
  pickup_phone_number?: string;
  dropoff_phone_number?: string;
  /** Centavos. */
  manifest_total_value?: number;
  external_store_id?: string;
}

export interface UberQuote {
  id: string;
  /** Centavos. */
  fee: number;
  currency?: string;
  currency_type?: string;
  expires?: string;
  dropoff_eta?: string;
  /** Minutos ate a entrega. */
  duration?: number;
  pickup_duration?: number;
}

export interface UberManifestItem {
  name: string;
  quantity: number;
  size: 'small' | 'medium' | 'large' | 'xlarge';
  /** Centavos. */
  price?: number;
}

export interface UberCreateDeliveryRequest {
  quote_id: string;
  pickup_name: string;
  pickup_address: string;
  pickup_phone_number: string;
  pickup_notes?: string;
  dropoff_name: string;
  dropoff_address: string;
  dropoff_phone_number: string;
  dropoff_notes?: string;
  /** Comprovação exigida do entregador na entrega (ex.: foto). */
  dropoff_verification?: { picture?: boolean };
  manifest_items: UberManifestItem[];
  manifest_total_value?: number;
  manifest_reference?: string;
  external_id?: string;
  idempotency_key?: string;
  test_specifications?: {
    robo_courier_specification: { mode: 'auto' };
  };
}

export interface UberCourier {
  name?: string;
  rating?: number | string;
  vehicle_type?: string;
  phone_number?: string;
  location?: { lat?: number; lng?: number };
  img_href?: string;
  vehicle_make?: string;
  vehicle_model?: string;
  vehicle_color?: string;
  vehicle_license_plate?: string;
}

export interface UberDelivery {
  id: string;
  status: string;
  /** Centavos. */
  fee?: number;
  tracking_url?: string;
  pickup_eta?: string;
  dropoff_eta?: string;
  courier?: UberCourier | null;
  undeliverable_reason?: string;
  external_id?: string;
}

/** Erro da Uber com o `code` da API (ex.: 'address_undeliverable'). */
export class UberApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_SAFETY_MS = 5 * 60 * 1000;

@Injectable()
export class UberDirectClient {
  private readonly logger = new Logger(UberDirectClient.name);
  /** Token por client_id (vale 30 dias; renovado 5 min antes). Em memoria por instancia. */
  private readonly tokens = new Map<
    string,
    { token: string; expiresAt: number; secretHash: string }
  >();

  private get authUrl(): string {
    return process.env.UBER_AUTH_URL || 'https://auth.uber.com/oauth/v2/token';
  }

  private get apiBase(): string {
    return (process.env.UBER_API_BASE_URL || 'https://api.uber.com/v1').replace(
      /\/+$/,
      '',
    );
  }

  /** Esquece o token (credencial trocada ou recusada). */
  forget(clientId: string): void {
    this.tokens.delete(clientId);
  }

  async token(creds: UberCredentials): Promise<string> {
    // Trocar o secret no painel invalida o cache mesmo com o mesmo client_id.
    const secretHash = creds.clientSecret.slice(-6);
    const cached = this.tokens.get(creds.clientId);
    if (
      cached &&
      cached.secretHash === secretHash &&
      cached.expiresAt - TOKEN_SAFETY_MS > Date.now()
    ) {
      return cached.token;
    }

    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'client_credentials',
      scope: 'eats.deliveries',
    });
    let res: Response;
    try {
      res = await fetch(this.authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(UBER_TIMEOUT_MS),
      });
    } catch (error) {
      throw new UberApiError(
        503,
        'network',
        `Uber indisponível (${(error as Error)?.name ?? 'erro'})`,
      );
    }
    const json = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    } | null;
    if (!res.ok || !json?.access_token) {
      this.logger.warn(
        `Uber auth recusou client ${creds.clientId}: HTTP ${res.status} ${json?.error ?? ''}`,
      );
      throw new UberApiError(
        res.status === 400 || res.status === 401 ? 401 : res.status,
        json?.error ?? 'auth_failed',
        'Credenciais da Uber Direct recusadas',
      );
    }
    this.tokens.set(creds.clientId, {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      secretHash,
    });
    return json.access_token;
  }

  private async call<T>(
    creds: UberCredentials,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    retryOn401 = true,
  ): Promise<T> {
    const token = await this.token(creds);
    const url = `${this.apiBase}/customers/${encodeURIComponent(creds.customerId)}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(UBER_TIMEOUT_MS),
      });
    } catch (error) {
      throw new UberApiError(
        503,
        'network',
        `Uber indisponível (${(error as Error)?.name ?? 'erro'})`,
      );
    }
    if (res.status === 401 && retryOn401) {
      this.forget(creds.clientId);
      return this.call<T>(creds, method, path, body, false);
    }
    const json = (await res.json().catch(() => null)) as
      | (T & { code?: string; message?: string })
      | null;
    if (!res.ok || !json) {
      const code = json?.code ?? `http_${res.status}`;
      this.logger.warn(
        `Uber ${method} ${path.replace(/del_[\w-]+/, 'del_…')}: HTTP ${res.status} ${code} ${json?.message ?? ''}`,
      );
      throw new UberApiError(
        res.status,
        code,
        json?.message ?? `Erro da Uber (HTTP ${res.status})`,
      );
    }
    return json;
  }

  createQuote(creds: UberCredentials, req: UberQuoteRequest) {
    return this.call<UberQuote>(creds, 'POST', '/delivery_quotes', req);
  }

  createDelivery(creds: UberCredentials, req: UberCreateDeliveryRequest) {
    return this.call<UberDelivery>(creds, 'POST', '/deliveries', req);
  }

  getDelivery(creds: UberCredentials, deliveryId: string) {
    return this.call<UberDelivery>(
      creds,
      'GET',
      `/deliveries/${encodeURIComponent(deliveryId)}`,
    );
  }

  cancelDelivery(creds: UberCredentials, deliveryId: string) {
    return this.call<UberDelivery>(
      creds,
      'POST',
      `/deliveries/${encodeURIComponent(deliveryId)}/cancel`,
      {},
    );
  }
}
