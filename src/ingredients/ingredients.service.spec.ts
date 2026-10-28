import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { IngredientsService } from './ingredients.service';
import { IngredientType, IngredientUnit } from './schemas/ingredient.schema';

// Testa apenas o algoritmo puro de resolução de preço (resolvePrice), que não
// depende dos models do Mongoose — não precisa de banco de dados para rodar.
describe('IngredientsService.resolvePrice', () => {
  const service = new IngredientsService({} as any, {} as any, {} as any);

  const leiteId = new Types.ObjectId().toString();
  const cremeId = new Types.ObjectId().toString();
  const recheioNinhoId = new Types.ObjectId().toString();
  const recheioKinderId = new Types.ObjectId().toString();

  function baseMap() {
    return new Map<string, any>([
      [
        leiteId,
        {
          _id: new Types.ObjectId(leiteId),
          type: IngredientType.SIMPLES,
          purchasePrice: 22.9,
          quantityPurchased: 400,
        },
      ],
      [
        cremeId,
        {
          _id: new Types.ObjectId(cremeId),
          type: IngredientType.SIMPLES,
          purchasePrice: 14.19,
          quantityPurchased: 1000,
        },
      ],
      [
        recheioNinhoId,
        {
          _id: new Types.ObjectId(recheioNinhoId),
          type: IngredientType.COMPOSTO,
          components: [
            { ingredientId: new Types.ObjectId(leiteId), quantity: 400 },
            { ingredientId: new Types.ObjectId(cremeId), quantity: 200 },
          ],
          yield: { quantity: 500, unit: IngredientUnit.GRAMAS },
        },
      ],
      [
        recheioKinderId,
        {
          _id: new Types.ObjectId(recheioKinderId),
          type: IngredientType.COMPOSTO,
          components: [
            { ingredientId: new Types.ObjectId(recheioNinhoId), quantity: 300 },
          ],
          yield: { quantity: 300, unit: IngredientUnit.GRAMAS },
        },
      ],
    ]);
  }

  it('resolves a SIMPLES ingredient as purchasePrice / quantityPurchased', () => {
    const map = baseMap();
    const price = service.resolvePrice(leiteId, map, new Map(), new Set());
    expect(price).toBeCloseTo(22.9 / 400, 6);
  });

  it('resolves a COMPOSTO ingredient recursively as sum(qty*unitCost)/yield', () => {
    const map = baseMap();
    const memo = new Map<string, number>();
    const leitePrice = service.resolvePrice(leiteId, map, memo, new Set());
    const cremePrice = service.resolvePrice(cremeId, map, memo, new Set());
    const expected = (leitePrice * 400 + cremePrice * 200) / 500;

    const price = service.resolvePrice(
      recheioNinhoId,
      map,
      new Map(),
      new Set(),
    );
    expect(price).toBeCloseTo(expected, 6);
  });

  it('resolves a second level of nesting (composto usando composto)', () => {
    const map = baseMap();
    const ninhoPrice = service.resolvePrice(
      recheioNinhoId,
      map,
      new Map(),
      new Set(),
    );
    const expected = (ninhoPrice * 300) / 300;

    const price = service.resolvePrice(
      recheioKinderId,
      map,
      new Map(),
      new Set(),
    );
    expect(price).toBeCloseTo(expected, 6);
    expect(price).toBeCloseTo(ninhoPrice, 6);
  });

  it('reuses a shared memo across multiple top-level resolutions', () => {
    const map = baseMap();
    const memo = new Map<string, number>();
    const spy = jest.spyOn(service, 'resolvePrice');

    service.resolvePrice(recheioNinhoId, map, memo, new Set());
    const callsAfterFirst = spy.mock.calls.length;
    service.resolvePrice(recheioKinderId, map, memo, new Set());
    // recheioKinderId depends on recheioNinhoId, which is already memoized —
    // so its own resolvePrice body still recurses into components, but the
    // memoized leite/creme lookups underneath recheioNinho are not redone.
    expect(memo.has(recheioNinhoId)).toBe(true);
    expect(memo.has(leiteId)).toBe(true);
    expect(callsAfterFirst).toBeGreaterThan(0);

    spy.mockRestore();
  });

  it('throws BadRequestException on a direct cycle (A -> A)', () => {
    const map = baseMap();
    map.set(recheioNinhoId, {
      ...map.get(recheioNinhoId),
      components: [
        { ingredientId: new Types.ObjectId(recheioNinhoId), quantity: 1 },
      ],
    });
    expect(() =>
      service.resolvePrice(recheioNinhoId, map, new Map(), new Set()),
    ).toThrow(BadRequestException);
  });

  it('throws BadRequestException on an indirect cycle (A -> B -> A)', () => {
    const map = baseMap();
    // Faz recheioNinho também depender de recheioKinder, que já depende de recheioNinho.
    map.set(recheioNinhoId, {
      ...map.get(recheioNinhoId),
      components: [
        ...map.get(recheioNinhoId).components,
        { ingredientId: new Types.ObjectId(recheioKinderId), quantity: 1 },
      ],
    });
    expect(() =>
      service.resolvePrice(recheioKinderId, map, new Map(), new Set()),
    ).toThrow(BadRequestException);
  });

  it('throws NotFoundException when a referenced ingredient is missing/inactive', () => {
    const map = baseMap();
    map.delete(leiteId);
    expect(() =>
      service.resolvePrice(recheioNinhoId, map, new Map(), new Set()),
    ).toThrow(NotFoundException);
  });

  it('reflects an updated leaf price immediately (no caching)', () => {
    const map = baseMap();
    const before = service.resolvePrice(
      recheioNinhoId,
      map,
      new Map(),
      new Set(),
    );

    map.set(leiteId, { ...map.get(leiteId), purchasePrice: 45.8 });
    const after = service.resolvePrice(
      recheioNinhoId,
      map,
      new Map(),
      new Set(),
    );

    expect(after).toBeGreaterThan(before);
  });
});

describe('IngredientsService.ensureOperationalCostIngredient', () => {
  const businessId = new Types.ObjectId().toString();

  function buildService(total: number) {
    const updateOne = jest.fn().mockResolvedValue({});
    const ingredientModel = { updateOne } as any;
    const expensesService = {
      getCurrentMonthOperationalCost: jest.fn().mockResolvedValue({
        total,
        hourlyRate: total / 168,
        periodStart: new Date(),
        periodEnd: new Date(),
      }),
    } as any;
    const service = new IngredientsService(
      ingredientModel,
      {} as any,
      expensesService,
    );
    return { service, updateOne, expensesService };
  }

  it('upserts the system ingredient keyed by businessId + isSystem + name', async () => {
    const { service, updateOne } = buildService(840);
    await service.ensureOperationalCostIngredient(businessId);

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter).toMatchObject({ isSystem: true, name: 'Custo Operacional' });
    expect(options).toEqual({ upsert: true });
    expect(update.$set).toMatchObject({
      purchasePrice: 840,
      quantityPurchased: 168,
      unit: 'HORA',
    });
    expect(update.$setOnInsert).toMatchObject({
      type: 'SIMPLES',
      isSystem: true,
      isFixedCost: true,
      isActive: true,
    });
  });

  it('always $sets purchasePrice from the current month sum, never $setOnInsert', async () => {
    const { service, updateOne } = buildService(0);
    await service.ensureOperationalCostIngredient(businessId);

    const [, update] = updateOne.mock.calls[0];
    // purchasePrice must be under $set (recomputed every call), not $setOnInsert
    // (which would only apply once, leaving it stale after the first insert).
    expect(update.$set.purchasePrice).toBe(0);
    expect(update.$setOnInsert.purchasePrice).toBeUndefined();
  });
});
