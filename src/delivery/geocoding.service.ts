import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  GeocodeCache,
  GeocodeCacheDocument,
  GeocodePrecision,
} from './schemas/geocode-cache.schema';
import { dropoffKey, StructuredAddress } from './uber-direct.util';
import type { GeoPoint } from './own-delivery.util';

export interface GeocodeResult extends GeoPoint {
  precision: GeocodePrecision;
  source: string;
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const BRASILAPI_CEP_URL = 'https://brasilapi.com.br/api/cep/v2';
const TIMEOUT_MS = 5000;
/** Politica de uso do Nominatim: no maximo 1 consulta por segundo. */
const NOMINATIM_GAP_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const validPoint = (lat: number | null, lng: number | null) =>
  lat !== null &&
  lng !== null &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180 &&
  !(lat === 0 && lng === 0);

/**
 * Endereco -> coordenadas, sem custo: Nominatim (OpenStreetMap) para chegar na
 * rua, depois no bairro e, por ultimo, a BrasilAPI (so quando o ponto do CEP e
 * proprio: o servico "open-cep" devolve o centro da cidade para qualquer CEP,
 * o que jogaria a loja para outro bairro). Resultado em cache.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private lastNominatimAt = 0;
  private nominatimQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectModel(GeocodeCache.name)
    private readonly cacheModel: Model<GeocodeCacheDocument>,
  ) {}

  async geocode(address: StructuredAddress): Promise<GeocodeResult | null> {
    const key = dropoffKey(address);
    const cached = await this.cacheModel
      .findOne({ key })
      .lean<GeocodeCache>()
      .exec();
    // Pontos antigos da BrasilAPI podem ser o centro da cidade: refaz a busca.
    if (cached && cached.source !== 'brasilapi') {
      return {
        lat: cached.lat,
        lng: cached.lng,
        precision: cached.precision,
        source: cached.source,
      };
    }

    const found =
      (await this.viaNominatim(address)) ??
      (await this.viaDistrict(address)) ??
      (await this.viaBrasilApi(address));
    if (!found) return null;
    await this.cacheModel
      .updateOne({ key }, { $set: { key, ...found } }, { upsert: true })
      .exec()
      .catch((e: Error) =>
        this.logger.warn(`Cache de geocoding não gravado: ${e.message}`),
      );
    return found;
  }

  /** Serializa as consultas ao Nominatim com 1,1 s entre elas. */
  private throttled<T>(job: () => Promise<T>): Promise<T> {
    const run = this.nominatimQueue.then(async () => {
      const wait = this.lastNominatimAt + NOMINATIM_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await job();
      } finally {
        this.lastNominatimAt = Date.now();
      }
    });
    this.nominatimQueue = run.catch(() => undefined);
    return run;
  }

  private async viaNominatim(
    a: StructuredAddress,
  ): Promise<GeocodeResult | null> {
    const hit = await this.nominatim({
      street: `${a.number.trim()} ${a.street.trim()}`,
      city: a.city.trim(),
      state: a.state.trim().toUpperCase(),
    });
    if (!hit) return null;
    const type = String(hit.addresstype ?? hit.type ?? '');
    return {
      ...hit.point,
      precision: /house|building|residential|apartments/i.test(type)
        ? 'ADDRESS'
        : 'STREET',
      source: 'nominatim',
    };
  }

  /** Rua fora do mapa: usa o centro do bairro (mais perto que o centro da cidade). */
  private async viaDistrict(
    a: StructuredAddress,
  ): Promise<GeocodeResult | null> {
    const district = a.district.trim();
    if (!district) return null;
    const hit = await this.nominatim({
      q: `${district}, ${a.city.trim()}, ${a.state.trim().toUpperCase()}`,
    });
    return hit
      ? { ...hit.point, precision: 'CEP', source: 'nominatim-district' }
      : null;
  }

  private async nominatim(
    query: Record<string, string>,
  ): Promise<{ point: GeoPoint; addresstype?: string; type?: string } | null> {
    const params = new URLSearchParams({
      format: 'jsonv2',
      limit: '1',
      countrycodes: 'br',
      ...query,
    });
    try {
      const body = await this.throttled(async () => {
        const res = await fetch(`${NOMINATIM_URL}?${params}`, {
          headers: {
            // A politica do Nominatim exige identificar a aplicacao.
            'User-Agent':
              process.env.GEOCODER_USER_AGENT ?? 'OrdemBee/1.0 (ordembee.com)',
            'Accept-Language': 'pt-BR',
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as unknown;
      });
      const hit = Array.isArray(body) ? body[0] : null;
      const lat = num(hit?.lat);
      const lng = num(hit?.lon);
      if (!validPoint(lat, lng)) return null;
      return {
        point: { lat: lat!, lng: lng! },
        addresstype: hit.addresstype,
        type: hit.type,
      };
    } catch (e) {
      this.logger.warn(`Nominatim indisponível: ${(e as Error).message}`);
      return null;
    }
  }

  private async viaBrasilApi(
    a: StructuredAddress,
  ): Promise<GeocodeResult | null> {
    const cep = a.cep.replace(/\D/g, '');
    if (cep.length !== 8) return null;
    try {
      const res = await fetch(`${BRASILAPI_CEP_URL}/${cep}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        service?: string;
        location?: {
          coordinates?: { latitude?: unknown; longitude?: unknown };
        };
      };
      // "open-cep" repete o centro da cidade em todos os CEPs: nao serve.
      if (body?.service === 'open-cep') return null;
      const lat = num(body?.location?.coordinates?.latitude);
      const lng = num(body?.location?.coordinates?.longitude);
      if (!validPoint(lat, lng)) return null;
      return { lat: lat!, lng: lng!, precision: 'CEP', source: 'brasilapi' };
    } catch (e) {
      this.logger.warn(`BrasilAPI indisponível: ${(e as Error).message}`);
      return null;
    }
  }
}
