import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  buildPage,
  PageRequest,
  Paginated,
} from '../common/pagination/pagination';
import {
  Ingredient,
  IngredientDocument,
  IngredientType,
  IngredientUnit,
} from './schemas/ingredient.schema';
import {
  IngredientPriceHistory,
  IngredientPriceHistoryDocument,
} from './schemas/ingredient-price-history.schema';
import { Pricing, PricingDocument } from '../pricings/schemas/pricing.schema';
import {
  CreateIngredientDto,
  IngredientComponentDto,
  IngredientYieldDto,
} from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import {
  ExpensesService,
  OPERATIONAL_HOURS_PER_MONTH,
} from '../expenses/expenses.service';

type LeanIngredient = Ingredient & { _id: Types.ObjectId };
export type ResolvedIngredient = LeanIngredient & { pricePerUnit: number };

/** Quem fez a mudanca (token Firebase); opcional para chamadas internas. */
export interface PriceActor {
  uid?: string;
  name?: string;
  role?: string;
}

export const OPERATIONAL_COST_INGREDIENT_NAME = 'Custo Operacional';

@Injectable()
export class IngredientsService {
  private readonly logger = new Logger(IngredientsService.name);

  constructor(
    @InjectModel(Ingredient.name)
    private readonly ingredientModel: Model<IngredientDocument>,
    @InjectModel(IngredientPriceHistory.name)
    private readonly historyModel: Model<IngredientPriceHistoryDocument>,
    @InjectModel(Pricing.name)
    private readonly pricingModel: Model<PricingDocument>,
    private readonly expensesService: ExpensesService,
  ) {}

  /**
   * Mantém o ingrediente de sistema "Custo Operacional" sincronizado com a soma
   * das despesas operacionais do mês corrente (÷ 168 horas/mês). Nunca fica
   * desatualizado porque é recalculado a cada chamada — mesmo princípio de
   * "sempre em tempo real" usado no resto do módulo.
   */
  async ensureOperationalCostIngredient(businessId: string): Promise<void> {
    const { total } =
      await this.expensesService.getCurrentMonthOperationalCost(businessId);
    await this.ingredientModel.updateOne(
      {
        businessId: new Types.ObjectId(businessId),
        isSystem: true,
        name: OPERATIONAL_COST_INGREDIENT_NAME,
      },
      {
        $set: {
          purchasePrice: total,
          quantityPurchased: OPERATIONAL_HOURS_PER_MONTH,
          unit: IngredientUnit.HORA,
          priceUpdatedAt: new Date(),
        },
        $setOnInsert: {
          name: OPERATIONAL_COST_INGREDIENT_NAME,
          type: IngredientType.SIMPLES,
          isSystem: true,
          isFixedCost: true,
          isActive: true,
        },
      },
      { upsert: true },
    );
  }

  /** Carrega todos os ingredientes ativos do negócio numa única query, indexados por id. */
  async loadActiveMap(
    businessId: string,
  ): Promise<Map<string, LeanIngredient>> {
    await this.ensureOperationalCostIngredient(businessId);
    const docs = await this.ingredientModel
      .find({ businessId: new Types.ObjectId(businessId), isActive: true })
      .lean<LeanIngredient[]>();
    return new Map(docs.map((d) => [d._id.toString(), d]));
  }

  /**
   * Resolve o preço por unidade de um ingrediente (simples ou composto) recursivamente.
   * `memo` é compartilhado entre chamadas para evitar recomputar sub-ingredientes
   * reaproveitados por várias receitas. `visiting` detecta ciclos dentro de um mesmo
   * caminho de resolução e deve ser uma nova instância por chamada de nível raiz.
   */
  resolvePrice(
    id: string,
    map: Map<string, LeanIngredient>,
    memo: Map<string, number>,
    visiting: Set<string>,
  ): number {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) {
      throw new BadRequestException(
        'Referência circular detectada entre ingredientes',
      );
    }
    const ing = map.get(id);
    if (!ing) {
      throw new NotFoundException('Ingrediente não encontrado ou inativo');
    }

    visiting.add(id);
    let price: number;
    if (ing.type === IngredientType.SIMPLES) {
      price = (ing.purchasePrice ?? 0) / (ing.quantityPurchased ?? 1);
    } else {
      let total = 0;
      for (const c of ing.components ?? []) {
        total +=
          this.resolvePrice(c.ingredientId.toString(), map, memo, visiting) *
          c.quantity;
      }
      price = total / (ing.yield?.quantity ?? 1);
    }
    visiting.delete(id);
    memo.set(id, price);
    return price;
  }

  /** Garante que todos os ids apontam para ingredientes ativos do negócio. */
  async assertIngredientsExist(
    bizObj: Types.ObjectId,
    ids: Types.ObjectId[],
  ): Promise<void> {
    const uniqueIds = [...new Set(ids.map((id) => id.toString()))];
    const found = await this.ingredientModel.countDocuments({
      _id: { $in: uniqueIds.map((id) => new Types.ObjectId(id)) },
      businessId: bizObj,
      isActive: true,
    });
    if (found !== uniqueIds.length) {
      throw new NotFoundException(
        'Um ou mais ingredientes selecionados não existem ou estão inativos',
      );
    }
  }

  private async withComputedPrices(
    docs: LeanIngredient[],
    businessId: string,
  ): Promise<ResolvedIngredient[]> {
    const map = await this.loadActiveMap(businessId);
    for (const d of docs) {
      if (!map.has(d._id.toString())) map.set(d._id.toString(), d);
    }
    const memo = new Map<string, number>();
    return docs.map((d) => {
      let pricePerUnit = 0;
      try {
        pricePerUnit = this.resolvePrice(
          d._id.toString(),
          map,
          memo,
          new Set(),
        );
      } catch (e) {
        this.logger.warn(
          `Falha ao calcular preço do ingrediente ${d._id.toString()}: ${(e as Error).message}`,
        );
      }
      return { ...d, pricePerUnit };
    });
  }

  /** Grava um ponto do histórico; falha aqui nunca derruba o salvamento do ingrediente. */
  private async recordPrice(
    businessId: string,
    ing: {
      _id: Types.ObjectId | string;
      name: string;
      unit?: IngredientUnit;
      purchasePrice?: number;
      quantityPurchased?: number;
    },
    previousPricePerUnit: number | null,
    actor?: PriceActor,
    opts: { effectiveAt?: Date; isBaseline?: boolean } = {},
  ): Promise<void> {
    try {
      const purchasePrice = ing.purchasePrice ?? 0;
      const quantityPurchased = ing.quantityPurchased ?? 1;
      await this.historyModel.create({
        businessId: new Types.ObjectId(businessId),
        ingredientId: new Types.ObjectId(String(ing._id)),
        ingredientName: ing.name,
        unit: ing.unit,
        purchasePrice,
        quantityPurchased,
        pricePerUnit: purchasePrice / quantityPurchased,
        previousPricePerUnit,
        effectiveAt: opts.effectiveAt ?? new Date(),
        isBaseline: opts.isBaseline ?? false,
        changedByUid: actor?.uid,
        changedByName: actor?.name,
        changedByRole: actor?.role,
      });
    } catch (e) {
      this.logger.error(
        `Falha ao gravar histórico de preço ${String(ing._id)}: ${(e as Error).message}`,
      );
    }
  }

  async create(
    businessId: string,
    dto: CreateIngredientDto,
    actor?: PriceActor,
  ): Promise<ResolvedIngredient> {
    const bizObj = new Types.ObjectId(businessId);
    const data: any = {
      name: dto.name,
      type: dto.type,
      businessId: bizObj,
      isFixedCost: dto.isFixedCost ?? false,
    };

    if (dto.type === IngredientType.SIMPLES) {
      data.unit = dto.unit;
      data.quantityPurchased = dto.quantityPurchased;
      data.purchasePrice = dto.purchasePrice;
      data.priceUpdatedAt = new Date();
    } else {
      await this.assertIngredientsExist(
        bizObj,
        dto.components.map((c) => new Types.ObjectId(c.ingredientId)),
      );
      data.components = this.mapComponents(dto.components);
      data.yield = dto.yield;
    }

    const created = await this.ingredientModel.create(data);
    if (dto.type === IngredientType.SIMPLES) {
      await this.recordPrice(businessId, created, null, actor);
    }
    this.logger.log(
      `Ingrediente criado: ${created._id.toString()} | negócio: ${businessId} | tipo: ${dto.type}`,
    );
    return (await this.withComputedPrices([created.toObject()], businessId))[0];
  }

  async findAll(
    businessId: string,
    type?: IngredientType,
    search?: string,
    includeInactive?: boolean,
    pageReq?: PageRequest | null,
  ): Promise<ResolvedIngredient[] | Paginated<ResolvedIngredient>> {
    await this.ensureOperationalCostIngredient(businessId);
    const filter: any = {
      businessId: new Types.ObjectId(businessId),
      ...(includeInactive ? {} : { isActive: true }),
    };
    if (type) filter.type = type;
    if (search) filter.name = { $regex: search, $options: 'i' };

    if (!pageReq) {
      const docs = await this.ingredientModel
        .find(filter)
        .sort({ name: 1 })
        .lean<LeanIngredient[]>();
      return this.withComputedPrices(docs, businessId);
    }

    const [docs, total] = await Promise.all([
      this.ingredientModel
        .find(filter)
        .sort({ name: 1, _id: 1 })
        .skip(pageReq.skip)
        .limit(pageReq.limit)
        .lean<LeanIngredient[]>(),
      this.ingredientModel.countDocuments(filter).exec(),
    ]);
    // Preço calculado só para a página (compostos resolvem seus componentes).
    return buildPage(await this.withComputedPrices(docs, businessId), total, pageReq);
  }

  async findOne(id: string, businessId: string): Promise<ResolvedIngredient> {
    const doc = await this.ingredientModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .lean<LeanIngredient>();
    if (!doc) {
      throw new NotFoundException('Ingrediente não encontrado');
    }
    return (await this.withComputedPrices([doc], businessId))[0];
  }

  async update(
    id: string,
    businessId: string,
    dto: UpdateIngredientDto,
    actor?: PriceActor,
  ): Promise<ResolvedIngredient> {
    const bizObj = new Types.ObjectId(businessId);
    const existing = await this.ingredientModel.findOne({
      _id: id,
      businessId: bizObj,
    });
    if (!existing) {
      throw new NotFoundException('Ingrediente não encontrado');
    }
    if (existing.isSystem) {
      throw new ConflictException(
        'Este ingrediente é gerenciado automaticamente pelo sistema e não pode ser editado',
      );
    }

    const update: any = {};
    if (dto.name !== undefined) update.name = dto.name;
    if (dto.isFixedCost !== undefined) update.isFixedCost = dto.isFixedCost;
    if (dto.isActive !== undefined) update.isActive = dto.isActive;

    if (existing.type === IngredientType.SIMPLES) {
      if (dto.unit !== undefined) update.unit = dto.unit;
      if (dto.quantityPurchased !== undefined)
        update.quantityPurchased = dto.quantityPurchased;
      if (dto.purchasePrice !== undefined)
        update.purchasePrice = dto.purchasePrice;
      if (
        dto.quantityPurchased !== undefined ||
        dto.purchasePrice !== undefined
      ) {
        update.priceUpdatedAt = new Date();
      }
    } else {
      if (dto.components !== undefined) {
        await this.assertIngredientsExist(
          bizObj,
          dto.components.map((c) => new Types.ObjectId(c.ingredientId)),
        );
        update.components = this.mapComponents(dto.components);
      }
      if (dto.yield !== undefined) update.yield = dto.yield;

      if (update.components || update.yield) {
        await this.assertNoCycle(
          businessId,
          id,
          update.components ?? existing.components,
          update.yield ?? existing.yield,
        );
      }
    }

    const updated = await this.ingredientModel
      .findOneAndUpdate({ _id: id, businessId: bizObj }, update, { new: true })
      .lean<LeanIngredient>();

    if (existing.type === IngredientType.SIMPLES) {
      const before =
        (existing.purchasePrice ?? 0) / (existing.quantityPurchased ?? 1);
      const after =
        (updated!.purchasePrice ?? 0) / (updated!.quantityPurchased ?? 1);
      if (before !== after) {
        // Ingrediente anterior ao histórico: registra o preço antigo como ponto de partida.
        const hasHistory = await this.historyModel.exists({
          businessId: bizObj,
          ingredientId: existing._id,
        });
        if (!hasHistory) {
          await this.recordPrice(businessId, existing, null, undefined, {
            effectiveAt:
              existing.priceUpdatedAt ??
              (existing as any).updatedAt ??
              new Date(),
            isBaseline: true,
          });
        }
        await this.recordPrice(businessId, updated!, before, actor);
      }
    }
    this.logger.log(`Ingrediente atualizado: ${id} | negócio: ${businessId}`);
    return (await this.withComputedPrices([updated!], businessId))[0];
  }

  async remove(id: string, businessId: string): Promise<void> {
    const bizObj = new Types.ObjectId(businessId);
    const idObj = new Types.ObjectId(id);

    const target = await this.ingredientModel.findOne({
      _id: idObj,
      businessId: bizObj,
    });
    if (!target) {
      throw new NotFoundException('Ingrediente não encontrado');
    }
    if (target.isSystem) {
      throw new ConflictException(
        'Este ingrediente é gerenciado automaticamente pelo sistema e não pode ser removido',
      );
    }

    const [usedInIngredient, usedInPricing] = await Promise.all([
      this.ingredientModel.exists({
        businessId: bizObj,
        isActive: true,
        type: IngredientType.COMPOSTO,
        'components.ingredientId': idObj,
      }),
      this.pricingModel.exists({
        businessId: bizObj,
        isActive: true,
        'items.ingredientId': idObj,
      }),
    ]);
    if (usedInIngredient) {
      throw new ConflictException(
        'Este ingrediente é usado em outro ingrediente composto ativo e não pode ser removido',
      );
    }
    if (usedInPricing) {
      throw new ConflictException(
        'Este ingrediente é usado em uma precificação ativa e não pode ser removido',
      );
    }

    const result = await this.ingredientModel.findOneAndUpdate(
      { _id: id, businessId: bizObj },
      { isActive: false },
      { new: true },
    );
    if (!result) {
      throw new NotFoundException('Ingrediente não encontrado');
    }
    this.logger.log(`Ingrediente desativado: ${id} | negócio: ${businessId}`);
  }

  private mapComponents(components: IngredientComponentDto[]) {
    return components.map((c) => ({
      ingredientId: new Types.ObjectId(c.ingredientId),
      quantity: c.quantity,
      ingredientName: c.ingredientName,
    }));
  }

  /** Simula a mudança proposta num mapa em memória e roda a resolução — reaproveita
   * a detecção de ciclo embutida em `resolvePrice` sem precisar de um DFS separado. */
  private async assertNoCycle(
    businessId: string,
    id: string,
    components: any[],
    yieldValue: IngredientYieldDto | undefined,
  ) {
    const map = await this.loadActiveMap(businessId);
    const current = map.get(id);
    map.set(id, {
      ...(current as LeanIngredient),
      _id: new Types.ObjectId(id),
      type: IngredientType.COMPOSTO,
      components,
      yield: yieldValue,
    } as LeanIngredient);
    this.resolvePrice(id, map, new Map(), new Set());
  }

  /**
   * Apaga um ponto do historico de preco. Nao mexe no preco atual do
   * ingrediente; o ponto seguinte passa a "vir de" onde o apagado vinha, para a
   * variacao dele nao apontar para um preco que deixou de existir no historico.
   */
  async deletePricePoint(
    pointId: string,
    businessId: string,
  ): Promise<{ deleted: true }> {
    if (!Types.ObjectId.isValid(pointId)) {
      throw new NotFoundException('Ponto do histórico não encontrado');
    }
    const biz = new Types.ObjectId(businessId);
    const point = await this.historyModel
      .findOneAndDelete({ _id: pointId, businessId: biz })
      .lean();
    if (!point) {
      throw new NotFoundException('Ponto do histórico não encontrado');
    }
    await this.historyModel.findOneAndUpdate(
      {
        businessId: biz,
        ingredientId: point.ingredientId,
        effectiveAt: { $gt: point.effectiveAt },
      },
      { $set: { previousPricePerUnit: point.previousPricePerUnit ?? null } },
      { sort: { effectiveAt: 1 } },
    );
    this.logger.log(
      `Ponto do histórico de preços apagado: ${pointId} (ingrediente ${point.ingredientId.toString()}) | negócio: ${businessId}`,
    );
    return { deleted: true };
  }

  /** Pontos do histórico (mais antigo primeiro), opcionalmente de um ingrediente e período. */
  async getPriceHistory(
    businessId: string,
    opts: { ingredientId?: string; from?: Date; to?: Date } = {},
  ) {
    const filter: any = { businessId: new Types.ObjectId(businessId) };
    if (opts.ingredientId) {
      filter.ingredientId = new Types.ObjectId(opts.ingredientId);
    }
    if (opts.from || opts.to) {
      filter.effectiveAt = {
        ...(opts.from ? { $gte: opts.from } : {}),
        ...(opts.to ? { $lte: opts.to } : {}),
      };
    }
    return this.historyModel
      .find(filter)
      .sort({ effectiveAt: 1 })
      .limit(2000)
      .lean();
  }

  /**
   * Variação por ingrediente no período: preço vigente no início (último ponto
   * antes de `from`, ou o primeiro dentro do período) × preço no fim.
   */
  async getPriceVariation(businessId: string, from: Date, to: Date) {
    const biz = new Types.ObjectId(businessId);
    const rows = await this.historyModel
      .find({ businessId: biz, effectiveAt: { $lte: to } })
      .sort({ effectiveAt: 1 })
      .lean();

    const byIng = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = r.ingredientId.toString();
      if (!byIng.has(k)) byIng.set(k, []);
      byIng.get(k)!.push(r);
    }

    const result: {
      ingredientId: string;
      ingredientName: string;
      unit?: IngredientUnit;
      startPrice: number;
      endPrice: number;
      changePercent: number | null;
      changes: number;
    }[] = [];

    for (const [ingredientId, list] of byIng) {
      const before = list.filter((r) => r.effectiveAt < from);
      const within = list.filter((r) => r.effectiveAt >= from);
      if (within.length === 0) continue; // sem mudança no período
      const start = before.length ? before[before.length - 1] : within[0];
      const end = within[within.length - 1];
      const changes = within.filter((r) => !r.isBaseline).length;
      result.push({
        ingredientId,
        ingredientName: end.ingredientName,
        unit: end.unit,
        startPrice: start.pricePerUnit,
        endPrice: end.pricePerUnit,
        changePercent:
          start.pricePerUnit > 0
            ? ((end.pricePerUnit - start.pricePerUnit) / start.pricePerUnit) *
              100
            : null,
        changes,
      });
    }
    return result.sort(
      (a, b) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0),
    );
  }
}
