import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
import {
  Business,
  BusinessDocument,
} from '../business/schemas/business.schema';
import {
  MenuOnline,
  MenuOnlineDocument,
} from '../menu/schemas/menu-online.schema';
import {
  DeliveryQuote,
  DeliveryQuoteDocument,
} from './schemas/delivery-quote.schema';
import { GeocodingService } from './geocoding.service';
import {
  estimatedRoadKm,
  pickTier,
  usesDistanceTiers,
} from './own-delivery.util';
import { dropoffKey, StructuredAddress } from './uber-direct.util';

/** A taxa calculada vale por 30 min — tempo de fechar o pedido. */
const QUOTE_TTL_MS = 30 * 60_000;

const reject = (reason: string, message: string) =>
  new ConflictException({ statusCode: 409, reason, message });

export interface OwnQuoteResult {
  quoteId: string;
  fee: number;
  expiresAt: string;
  etaMinutes: null;
  distanceKm: number;
}

export interface DeliveryOriginResult {
  lat: number;
  lng: number;
  source: 'AUTO' | 'MANUAL';
  precision: 'ADDRESS' | 'STREET' | 'CEP';
  label: string;
}

const label = (a: StructuredAddress) =>
  `${a.street}, ${a.number} - ${a.district}, ${a.city}/${a.state.toUpperCase()}`;

/**
 * Entrega propria cobrada por distancia: endereco do cliente -> coordenadas ->
 * km estimados por rua -> faixa do dono. A cotacao fica guardada (mesma
 * colecao da Uber) e o pedido cobra o valor dela, nunca um enviado pelo navegador.
 */
@Injectable()
export class OwnDeliveryService {
  private readonly logger = new Logger(OwnDeliveryService.name);

  constructor(
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
    @InjectModel(MenuOnline.name)
    private readonly menuModel: Model<MenuOnlineDocument>,
    @InjectModel(DeliveryQuote.name)
    private readonly quoteModel: Model<DeliveryQuoteDocument>,
    private readonly geocoding: GeocodingService,
  ) {}

  async quoteForMenu(
    slug: string,
    address: StructuredAddress,
    now = new Date(),
  ): Promise<OwnQuoteResult> {
    const menu = await this.menuModel
      .findOne({ slug })
      .select('businessId enabled store.delivery')
      .lean<Pick<MenuOnline, 'businessId' | 'enabled' | 'store'>>()
      .exec();
    if (!menu?.enabled) throw new NotFoundException('Cardápio não encontrado');
    const delivery = menu.store?.delivery;
    if (delivery?.deliveryEnabled === false || !usesDistanceTiers(delivery)) {
      throw reject(
        'DELIVERY_DISABLED',
        'Esta loja não cobra entrega por distância.',
      );
    }
    const origin = await this.currentOrigin(menu.businessId, delivery.origin);
    if (!origin) {
      this.logger.error(
        `Faixas de entrega sem ponto de saída: negócio=${menu.businessId.toString()}`,
      );
      throw new ServiceUnavailableException(
        'A loja ainda não configurou a entrega. Fale com a loja pelo WhatsApp.',
      );
    }

    const point = await this.geocoding.geocode(address);
    if (!point) {
      throw new BadRequestException({
        statusCode: 400,
        message:
          'Não conseguimos localizar esse endereço. Confira os dados e tente de novo.',
        fields: ['address'],
      });
    }
    const distanceKm = estimatedRoadKm(origin, point);
    const tier = pickTier(delivery.ownTiers, distanceKm);
    if (!tier) {
      throw reject(
        'DELIVERY_UNAVAILABLE',
        'Esse endereço fica fora da área de entrega da loja.',
      );
    }

    const quoteId = randomUUID();
    const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);
    await this.quoteModel.create({
      businessId: menu.businessId,
      quoteId,
      fee: tier.fee,
      expiresAt,
      dropoffKey: dropoffKey(address),
      distanceKm,
    });
    return {
      quoteId,
      fee: tier.fee,
      expiresAt: expiresAt.toISOString(),
      etaMinutes: null,
      distanceKm,
    };
  }

  /**
   * A saída das entregas é o endereço do negócio: se o cadastro mudou (ou nunca
   * virou ponto), localiza de novo. Sem endereço cadastrado, vale o ponto antigo.
   */
  private async currentOrigin(
    businessId: Types.ObjectId,
    saved?: MenuOnline['store']['delivery']['origin'] | null,
  ): Promise<NonNullable<typeof saved> | DeliveryOriginResult | null> {
    const business = await this.businessModel
      .findById(businessId)
      .select('address')
      .lean()
      .exec();
    const a = business?.address;
    if (!a?.cep || !a.street || !a.number) return saved ?? null;
    const wanted = label({
      cep: a.cep,
      street: a.street,
      number: a.number,
      district: a.district,
      city: a.city,
      state: a.state,
    });
    if (saved && saved.source === 'AUTO' && saved.label === wanted) return saved;
    try {
      return await this.setOrigin(businessId.toString());
    } catch (err) {
      this.logger.warn(
        `Não foi possível atualizar a saída das entregas: negócio=${businessId.toString()} | ${(err as Error).message}`,
      );
      return saved ?? null;
    }
  }

  /**
   * Define o ponto de saida: o endereco da loja (AUTO) ou um endereco
   * informado pelo dono (MANUAL). Grava no cardapio e devolve o ponto.
   */
  async setOrigin(
    businessId: string,
    address?: StructuredAddress,
  ): Promise<DeliveryOriginResult> {
    const id = new Types.ObjectId(businessId);
    let target = address;
    if (!target) {
      const business = await this.businessModel
        .findById(id)
        .select('address')
        .lean()
        .exec();
      const a = business?.address;
      if (!a?.cep || !a.street || !a.number) {
        throw new BadRequestException(
          'Cadastre o endereço da loja em Minha Loja ou informe um endereço de saída',
        );
      }
      target = {
        cep: a.cep,
        street: a.street,
        number: a.number,
        district: a.district,
        city: a.city,
        state: a.state,
      };
    }
    const point = await this.geocoding.geocode(target);
    if (!point) {
      throw new BadRequestException(
        'Não conseguimos localizar esse endereço. Confira os dados e tente de novo.',
      );
    }
    const origin: DeliveryOriginResult = {
      lat: point.lat,
      lng: point.lng,
      source: address ? 'MANUAL' : 'AUTO',
      precision: point.precision,
      label: label(target),
    };
    await this.menuModel
      .updateOne(
        { businessId: id },
        { $set: { 'store.delivery.origin': origin } },
        { upsert: true },
      )
      .exec();
    this.logger.log(
      `Ponto de saída definido: negócio=${businessId} | ${origin.source} | ${origin.precision}`,
    );
    return origin;
  }
}
