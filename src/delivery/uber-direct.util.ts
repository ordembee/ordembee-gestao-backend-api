import { createHmac, timingSafeEqual } from 'crypto';
import type {
  UberAddress,
  UberCourier,
  UberDelivery,
} from './uber-direct.client';
import {
  UBER_DELIVERY_STATUSES,
  UberDeliveryStatus,
} from '../orders/schemas/order.schema';

/** Endereco estruturado usado na coleta e na entrega. */
export interface StructuredAddress {
  cep: string;
  street: string;
  number: string;
  district: string;
  city: string;
  state: string;
  complement?: string;
}

export const cents = (reais: number) => Math.round(reais * 100);

/** Até quantas unidades o pedido ainda cabe na bag de uma moto. */
export const MOTO_MAX_UNITS = 10;

/**
 * Tamanho declarado à Uber em todos os itens do pedido. A API não deixa
 * escolher o veículo: o tamanho é a indicação que ela usa. Até
 * `MOTO_MAX_UNITS` unidades vai 'small' (cabe em moto); acima disso,
 * 'large' (carro). É indicação, não garantia — quem decide é a Uber.
 */
export function manifestSize(totalUnits: number): 'small' | 'large' {
  return totalUnits <= MOTO_MAX_UNITS ? 'small' : 'large';
}
export const reais = (centavos: number) => Math.round(centavos) / 100;

/**
 * Telefone brasileiro para E.164: '21999999999' -> '+5521999999999'.
 * Aceita o que ja vier com +55. Devolve null se nao for um numero valido.
 */
export function toE164BR(raw: string | undefined | null): string | null {
  const value = String(raw ?? '').trim();
  let digits = value.replace(/\D/g, '');
  if (value.startsWith('+')) {
    if (!digits.startsWith('55')) return null;
    digits = digits.slice(2);
  } else if (digits.length >= 12 && digits.startsWith('55')) {
    digits = digits.slice(2);
  }
  return /^\d{10,11}$/.test(digits) ? `+55${digits}` : null;
}

const cepMask = (cep: string) => {
  const d = cep.replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
};

/** Formato da Uber: as linhas da rua e o resto em campos, serializado como string. */
export function toUberAddress(a: StructuredAddress): string {
  const address: UberAddress = {
    street_address: [
      `${a.street.trim()}, ${a.number.trim()} - ${a.district.trim()}`,
      ...(a.complement?.trim() ? [a.complement.trim()] : []),
    ],
    city: a.city.trim(),
    state: a.state.trim().toUpperCase(),
    zip_code: cepMask(a.cep),
    country: 'BR',
  };
  return JSON.stringify(address);
}

/**
 * Chave canonica do destino: a cotacao so vale para o mesmo endereco. Ignora
 * caixa, acento e espacos para "Rua A" e "rua  a" serem o mesmo lugar.
 * Complemento nao muda o preco, entao nao entra.
 */
export function dropoffKey(a: StructuredAddress): string {
  const n = (v: string | undefined) =>
    String(v ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  return [
    a.cep.replace(/\D/g, ''),
    n(a.street),
    n(a.number),
    n(a.district),
    n(a.city),
    n(a.state),
  ].join('|');
}

/** Uma linha so, para a folha impressa e o cadastro do cliente. */
export function formatStructuredAddress(a: StructuredAddress): string {
  const line1 = [`${a.street}, ${a.number}`, a.complement]
    .filter(Boolean)
    .join(' – ');
  return `${line1}\n${a.district} · ${a.city}/${a.state.toUpperCase()} · CEP ${cepMask(a.cep)}`;
}

/** `x-uber-signature` (ou `x-postmates-signature`) = hex(HMAC-SHA256(chave, corpo cru)). */
export function verifyUberSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  signingKey: string,
): boolean {
  const received = String(signature ?? '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = createHmac('sha256', signingKey)
    .update(rawBody)
    .digest('hex');
  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(received, 'hex'),
  );
}

export function isUberStatus(value: unknown): value is UberDeliveryStatus {
  return (
    typeof value === 'string' &&
    (UBER_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

const date = (v: string | undefined) => {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
};

/** Entregador no formato do pedido (so o que a tela usa). */
export function mapCourier(c: UberCourier | null | undefined) {
  if (!c || (!c.name && !c.phone_number)) return undefined;
  const rating = Number(c.rating);
  return {
    name: c.name || undefined,
    phone: c.phone_number || undefined,
    vehicleType: c.vehicle_type || undefined,
    vehicleMake: c.vehicle_make || undefined,
    vehicleModel: c.vehicle_model || undefined,
    vehicleColor: c.vehicle_color || undefined,
    licensePlate: c.vehicle_license_plate || undefined,
    photoUrl: c.img_href || undefined,
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    lat: c.location?.lat,
    lng: c.location?.lng,
    updatedAt: new Date(),
  };
}

/** Campos da corrida que o pedido espelha (status, ETA, entregador, link). */
export function mapDelivery(d: Partial<UberDelivery>) {
  return {
    status: isUberStatus(d.status) ? d.status : undefined,
    fee: typeof d.fee === 'number' ? reais(d.fee) : undefined,
    trackingUrl: d.tracking_url || undefined,
    pickupEta: date(d.pickup_eta),
    dropoffEta: date(d.dropoff_eta),
    courier: mapCourier(d.courier),
    failureReason: d.undeliverable_reason || undefined,
  };
}

export interface UberWebhookEvent {
  kind: string;
  deliveryId: string | null;
  status: UberDeliveryStatus | undefined;
  delivery: Partial<UberDelivery>;
  /** Posicao do entregador (event.courier_update). */
  location?: { lat?: number; lng?: number };
}

/**
 * Le o corpo do webhook sem confiar no formato: `event.delivery_status` traz
 * `delivery_id`, `status` e `data` (a corrida); `event.courier_update` traz
 * `delivery_id`, `data.courier` e `location`.
 */
export function parseUberWebhook(body: unknown): UberWebhookEvent {
  const b = (body && typeof body === 'object' ? body : {}) as Record<
    string,
    any
  >;
  const data = (
    b.data && typeof b.data === 'object' ? b.data : {}
  ) as Partial<UberDelivery>;
  const deliveryId =
    (typeof b.delivery_id === 'string' && b.delivery_id) ||
    (typeof data.id === 'string' && data.id) ||
    null;
  const status = isUberStatus(b.status)
    ? b.status
    : isUberStatus(data.status)
      ? data.status
      : undefined;
  const location =
    b.location && typeof b.location === 'object'
      ? { lat: Number(b.location.lat), lng: Number(b.location.lng) }
      : undefined;
  return {
    kind: typeof b.kind === 'string' ? b.kind : '',
    deliveryId,
    status,
    delivery: data,
    location,
  };
}

/** Texto curto do status para log e linha do historico. */
export const UBER_STATUS_LABEL: Record<UberDeliveryStatus, string> = {
  pending: 'Procurando entregador',
  pickup: 'Entregador a caminho da loja',
  pickup_complete: 'Pedido coletado',
  dropoff: 'A caminho do cliente',
  delivered: 'Entregue',
  canceled: 'Cancelada',
  returned: 'Devolvida à loja',
};
