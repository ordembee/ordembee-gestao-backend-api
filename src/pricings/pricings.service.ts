import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Pricing,
  PricingDocument,
  PricingItem,
} from './schemas/pricing.schema';
import { CreatePricingDto, PricingItemDto } from './dto/create-pricing.dto';
import { UpdatePricingDto } from './dto/update-pricing.dto';
import { IngredientsService } from '../ingredients/ingredients.service';

type LeanPricing = Pricing & { _id: Types.ObjectId };
export type ResolvedPricing = LeanPricing & {
  custoFinal: number | null;
  lucro: number | null;
  margem: number | null;
};

@Injectable()
export class PricingsService {
  private readonly logger = new Logger(PricingsService.name);

  constructor(
    @InjectModel(Pricing.name)
    private readonly pricingModel: Model<PricingDocument>,
    private readonly ingredientsService: IngredientsService,
  ) {}

  async create(
    businessId: string,
    dto: CreatePricingDto,
  ): Promise<ResolvedPricing> {
    const bizObj = new Types.ObjectId(businessId);
    await this.ingredientsService.assertIngredientsExist(
      bizObj,
      dto.items.map((i) => new Types.ObjectId(i.ingredientId)),
    );

    const created = await this.pricingModel.create({
      name: dto.name,
      businessId: bizObj,
      precoVenda: dto.precoVenda,
      items: this.mapItems(dto.items),
    });
    this.logger.log(
      `Precificação criada: ${created._id.toString()} | negócio: ${businessId}`,
    );
    return this.enrich(businessId, created.toObject());
  }

  async findAll(
    businessId: string,
    includeInactive?: boolean,
  ): Promise<ResolvedPricing[]> {
    const filter: any = {
      businessId: new Types.ObjectId(businessId),
      ...(includeInactive ? {} : { isActive: true }),
    };
    const docs = await this.pricingModel
      .find(filter)
      .sort({ name: 1 })
      .lean<LeanPricing[]>();

    const map = await this.ingredientsService.loadActiveMap(businessId);
    const memo = new Map<string, number>();
    return docs.map((d) => this.computeTotals(d, map, memo));
  }

  /** Precificações ativas dentre os ids informados — usado por ProductsService
   * para resolver o custo do produto a partir do seu `pricingId` (em lote). */
  async findManyByIds(
    businessId: string,
    ids: Types.ObjectId[],
  ): Promise<ResolvedPricing[]> {
    if (!ids.length) return [];
    const docs = await this.pricingModel
      .find({
        businessId: new Types.ObjectId(businessId),
        _id: { $in: ids },
        isActive: true,
      })
      .lean<LeanPricing[]>();
    if (!docs.length) return [];

    const map = await this.ingredientsService.loadActiveMap(businessId);
    const memo = new Map<string, number>();
    return docs.map((d) => this.computeTotals(d, map, memo));
  }

  /** Existe e está ativa nesse negócio — usado por ProductsService para
   * validar um `pricingId` recebido antes de vincular. */
  async existsActive(businessId: string, pricingId: string): Promise<boolean> {
    const found = await this.pricingModel.exists({
      _id: new Types.ObjectId(pricingId),
      businessId: new Types.ObjectId(businessId),
      isActive: true,
    });
    return !!found;
  }

  async findOne(id: string, businessId: string): Promise<ResolvedPricing> {
    const doc = await this.pricingModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .lean<LeanPricing>();
    if (!doc) {
      throw new NotFoundException('Precificação não encontrada');
    }
    return this.enrich(businessId, doc);
  }

  async update(
    id: string,
    businessId: string,
    dto: UpdatePricingDto,
  ): Promise<ResolvedPricing> {
    const bizObj = new Types.ObjectId(businessId);
    const update: any = {};
    if (dto.name !== undefined) update.name = dto.name;
    if (dto.precoVenda !== undefined) update.precoVenda = dto.precoVenda;
    if (dto.isActive !== undefined) update.isActive = dto.isActive;
    if (dto.items !== undefined) {
      await this.ingredientsService.assertIngredientsExist(
        bizObj,
        dto.items.map((i) => new Types.ObjectId(i.ingredientId)),
      );
      update.items = this.mapItems(dto.items);
    }

    const updated = await this.pricingModel
      .findOneAndUpdate({ _id: id, businessId: bizObj }, update, { new: true })
      .lean<LeanPricing>();
    if (!updated) {
      throw new NotFoundException('Precificação não encontrada');
    }
    this.logger.log(`Precificação atualizada: ${id} | negócio: ${businessId}`);
    return this.enrich(businessId, updated);
  }

  async remove(id: string, businessId: string): Promise<void> {
    const result = await this.pricingModel.findOneAndUpdate(
      { _id: id, businessId: new Types.ObjectId(businessId) },
      { isActive: false },
      { new: true },
    );
    if (!result) {
      throw new NotFoundException('Precificação não encontrada');
    }
    this.logger.log(`Precificação desativada: ${id} | negócio: ${businessId}`);
  }

  private mapItems(items: PricingItemDto[]): PricingItem[] {
    return items.map((i) => ({
      ingredientId: new Types.ObjectId(i.ingredientId),
      quantity: i.quantity,
      ingredientName: i.ingredientName,
    })) as PricingItem[];
  }

  private async enrich(
    businessId: string,
    doc: LeanPricing,
  ): Promise<ResolvedPricing> {
    const map = await this.ingredientsService.loadActiveMap(businessId);
    return this.computeTotals(doc, map, new Map());
  }

  private computeTotals(
    doc: LeanPricing,
    map: Map<string, any>,
    memo: Map<string, number>,
  ): ResolvedPricing {
    try {
      let custoFinal = 0;
      for (const item of doc.items) {
        const unitCost = this.ingredientsService.resolvePrice(
          item.ingredientId.toString(),
          map,
          memo,
          new Set(),
        );
        custoFinal += unitCost * item.quantity;
      }
      const lucro = doc.precoVenda - custoFinal;
      const margem = doc.precoVenda > 0 ? lucro / doc.precoVenda : null;
      return { ...doc, custoFinal, lucro, margem };
    } catch (e) {
      this.logger.warn(
        `Falha ao calcular precificação ${doc._id.toString()}: ${(e as Error).message}`,
      );
      return { ...doc, custoFinal: null, lucro: null, margem: null };
    }
  }
}
