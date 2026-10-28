import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { SalesService } from './sales.service';
import { PaymentMethod } from '../common/enums/payment-method.enum';
import { SaleChannel } from '../common/enums/sale-channel.enum';

// Regressão do bug: vendas de um produto vinculado a uma precificação usavam
// `product.costPrice` cru (sempre 0/desatualizado para produtos vinculados,
// já que esse campo nunca é persistido nesse caso — ver ProductsService),
// inflando o lucro da venda para o valor da receita. `resolveCostPrices` deve
// usar o `custoFinal` em tempo real da precificação vinculada, com fallback
// pro costPrice estático quando não há vínculo (ou o vínculo está quebrado).
describe('SalesService.resolveCostPrices', () => {
  function buildService(pricings: any[]) {
    const pricingsService = {
      findManyByIds: jest.fn().mockResolvedValue(pricings),
    } as any;
    const service = new SalesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      pricingsService,
      {} as any,
      {
        prepareForDocument: jest
          .fn()
          .mockResolvedValue({
            tags: [],
            discount: null,
            added: [],
            removed: [],
            existing: [],
          }),
        commitUsage: jest.fn().mockResolvedValue(undefined),
        releaseUsage: jest.fn().mockResolvedValue(undefined),
      } as any,
    );
    return { service, pricingsService };
  }

  it('uses the live custoFinal for a product linked to a pricing', async () => {
    const pricingId = new Types.ObjectId();
    const productId = new Types.ObjectId();
    const { service } = buildService([{ _id: pricingId, custoFinal: 28.66 }]);

    const products = [{ _id: productId, pricingId, costPrice: 0 } as any];

    const result = await (service as any).resolveCostPrices('biz1', products);
    expect(result.get(String(productId))).toBe(28.66);
  });

  it('falls back to the static costPrice when the product has no pricing link', async () => {
    const productId = new Types.ObjectId();
    const { service } = buildService([]);

    const products = [{ _id: productId, costPrice: 12.5 } as any];

    const result = await (service as any).resolveCostPrices('biz1', products);
    expect(result.get(String(productId))).toBe(12.5);
  });

  it('falls back to the static costPrice when the linked pricing is missing/inactive', async () => {
    const pricingId = new Types.ObjectId();
    const productId = new Types.ObjectId();
    // findManyByIds só retorna precificações ativas — simula não achar nada.
    const { service } = buildService([]);

    const products = [{ _id: productId, pricingId, costPrice: 7 } as any];

    const result = await (service as any).resolveCostPrices('biz1', products);
    expect(result.get(String(productId))).toBe(7);
  });

  it('falls back to the static costPrice when custoFinal could not be resolved (null)', async () => {
    const pricingId = new Types.ObjectId();
    const productId = new Types.ObjectId();
    const { service } = buildService([{ _id: pricingId, custoFinal: null }]);

    const products = [{ _id: productId, pricingId, costPrice: 9.9 } as any];

    const result = await (service as any).resolveCostPrices('biz1', products);
    expect(result.get(String(productId))).toBe(9.9);
  });
});

describe('SalesService.create — venda fiado exige cliente', () => {
  it('rejeita venda com pagamento FIADO sem customerId', async () => {
    const userModel = {
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      }),
    } as any;
    const service = new SalesService(
      {} as any,
      userModel,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        prepareForDocument: jest
          .fn()
          .mockResolvedValue({
            tags: [],
            discount: null,
            added: [],
            removed: [],
            existing: [],
          }),
        commitUsage: jest.fn().mockResolvedValue(undefined),
        releaseUsage: jest.fn().mockResolvedValue(undefined),
      } as any,
    );

    const dto = {
      items: [],
      total: 10,
      channel: SaleChannel.CAIXA,
      payments: [{ method: PaymentMethod.FIADO, amount: 10 }],
    } as any;

    await expect(service.create('uid1', 'biz1', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('SalesService.settleDebt', () => {
  const businessId = new Types.ObjectId().toString();

  function buildService() {
    const user = { _id: new Types.ObjectId() };
    const userModel = {
      findOne: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(user) }),
    } as any;
    const saleModel = {
      findOneAndUpdate: jest.fn(),
    } as any;
    const service = new SalesService(
      saleModel,
      userModel,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        prepareForDocument: jest
          .fn()
          .mockResolvedValue({
            tags: [],
            discount: null,
            added: [],
            removed: [],
            existing: [],
          }),
        commitUsage: jest.fn().mockResolvedValue(undefined),
        releaseUsage: jest.fn().mockResolvedValue(undefined),
      } as any,
    );
    return { service, saleModel, user };
  }

  it('marca a dívida como quitada e grava quem quitou', async () => {
    const { service, saleModel, user } = buildService();
    const settledSale = { _id: 'sale1', debtSettled: true };
    saleModel.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(settledSale),
    });

    const result = await service.settleDebt('sale1', businessId, 'uid1');

    expect(result).toBe(settledSale);
    const [filter, update] = saleModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      _id: 'sale1',
      debtSettled: false,
      'payments.method': PaymentMethod.FIADO,
    });
    expect(update).toMatchObject({
      debtSettled: true,
      debtSettledBy: user._id,
    });
  });

  it('lança NotFoundException quando a venda não existe ou já foi quitada', async () => {
    const { service, saleModel } = buildService();
    saleModel.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.settleDebt('sale1', businessId, 'uid1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
