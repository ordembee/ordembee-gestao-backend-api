/** Entrega propria com taxa por faixa de distancia (km estimados por rua). */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface DeliveryTier {
  /** Ate quantos km (estimados por rua) esta faixa vale. */
  maxKm: number;
  /** Taxa em reais. */
  fee: number;
}

/** A rua e mais longa que a linha reta: fator medio para ruas de cidade. */
export const ROAD_FACTOR = 1.25;

export const MAX_TIERS = 20;
export const MAX_TIER_KM = 100;

const EARTH_RADIUS_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Distancia em linha reta (km) entre dois pontos — formula de Haversine. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distancia estimada por ruas (km, 2 casas): linha reta x `ROAD_FACTOR`. */
export function estimatedRoadKm(a: GeoPoint, b: GeoPoint): number {
  return round2(haversineKm(a, b) * ROAD_FACTOR);
}

/** Faixas em ordem crescente de km. */
export function sortTiers(tiers: DeliveryTier[] | undefined): DeliveryTier[] {
  return [...(tiers ?? [])]
    .map((t) => ({ maxKm: round2(t.maxKm), fee: round2(t.fee) }))
    .sort((x, y) => x.maxKm - y.maxKm);
}

/** Primeira faixa que alcanca `km`; null = fora da area de entrega. */
export function pickTier(
  tiers: DeliveryTier[] | undefined,
  km: number,
): DeliveryTier | null {
  return sortTiers(tiers).find((t) => km <= t.maxKm) ?? null;
}

/** Mensagem de erro se as faixas forem invalidas (km repetido ou fora dos limites). */
export function tiersError(tiers: DeliveryTier[]): string | null {
  if (tiers.length > MAX_TIERS) return `No máximo ${MAX_TIERS} faixas`;
  const seen = new Set<number>();
  for (const t of tiers) {
    if (!(t.maxKm > 0 && t.maxKm <= MAX_TIER_KM)) {
      return `Cada faixa deve ir de 0,1 a ${MAX_TIER_KM} km`;
    }
    if (!(t.fee >= 0)) return 'A taxa de cada faixa não pode ser negativa';
    const km = round2(t.maxKm);
    if (seen.has(km)) return 'Há duas faixas com o mesmo limite de km';
    seen.add(km);
  }
  return null;
}

/** Entrega propria cobrada por distancia: provedor proprio e ao menos uma faixa. */
export function usesDistanceTiers(
  delivery:
    | {
        deliveryProvider?: string;
        ownTiers?: DeliveryTier[];
        quoteAfterOrder?: boolean;
      }
    | undefined,
): boolean {
  // Taxa cotada depois do pedido (manual): as faixas nao valem.
  return (
    delivery?.deliveryProvider !== 'UBER' &&
    !delivery?.quoteAfterOrder &&
    !!delivery?.ownTiers?.length
  );
}
