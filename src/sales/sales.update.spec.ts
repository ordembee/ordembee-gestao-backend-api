import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { SalesService } from './sales.service';
import { Sale, SaleStatus } from './schemas/sale.schema';
import { Customer } from '../customers/schemas/customer.schema';
import { StockMovementsService } from '../stock-movements/stock-movements.service';
import { PricingsService } from '../pricings/pricings.service';
import { BusinessService } from '../business/business.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { MovementType } from '../stock-movements/schemas/stock-movement.schema';

/**
 * Mock de Query do Mongoose: aceita as cadeias usadas por `update()`/`findOne()`
 * (`.exec()`, `.populate().exec()`, `.select().exec()`) e resolve `result`.
 */
function query(result: unknown) {
  const q: any = {
    exec: jest.fn().mockResolvedValue(result),
    populate: jest.fn(() => q),
    select: jest.fn(() => q),
  };
  return q;
}

describe('SalesService - update() method', () => {
  let service: SalesService;
  let mockSaleModel: any;
  let mockUserModel: any;
  let mockProductModel: any;
  let mockStockMovementsService: any;
  let mockPricingsService: any;

  const mockBusinessId = new Types.ObjectId().toString();
  const mockSaleId = new Types.ObjectId().toString();
  const mockProductId = new Types.ObjectId().toString();
  const mockUserId = new Types.ObjectId();
  const mockFirebaseUid = 'test-firebase-uid';

  beforeEach(async () => {
    mockSaleModel = {
      findOne: jest.fn(),
      findByIdAndUpdate: jest.fn(() => query({})),
    };

    mockUserModel = {
      findOne: jest.fn(() => query(null)),
    };

    mockProductModel = {
      find: jest.fn(() => query([])),
      findById: jest.fn(() => query(null)),
      updateOne: jest.fn().mockResolvedValue({}),
    };

    mockStockMovementsService = {
      recordSaleMovement: jest.fn(),
    };

    mockPricingsService = {
      findManyByIds: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        {
          provide: getModelToken(Sale.name),
          useValue: mockSaleModel,
        },
        {
          provide: 'UserModel',
          useValue: mockUserModel,
        },
        {
          provide: 'ProductModel',
          useValue: mockProductModel,
        },
        {
          provide: getModelToken(Customer.name),
          useValue: {},
        },
        {
          provide: StockMovementsService,
          useValue: mockStockMovementsService,
        },
        {
          provide: PricingsService,
          useValue: mockPricingsService,
        },
        {
          provide: BusinessService,
          useValue: {
            getTimezone: jest.fn().mockResolvedValue('America/Sao_Paulo'),
          },
        },
        {
          provide: CampaignsService,
          useValue: {
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
          },
        },
      ],
    }).compile();

    // Inject correct models
    (module.get(SalesService) as any).saleModel = mockSaleModel;
    (module.get(SalesService) as any).userModel = mockUserModel;
    (module.get(SalesService) as any).productModel = mockProductModel;
    (module.get(SalesService) as any).stockMovementsService =
      mockStockMovementsService;
    (module.get(SalesService) as any).pricingsService = mockPricingsService;

    service = module.get<SalesService>(SalesService);
  });

  describe('update() - Validações Básicas', () => {
    it('deve lançar NotFoundException se venda não existe', async () => {
      mockSaleModel.findOne.mockReturnValueOnce(query(null));

      await expect(
        service.update(
          mockSaleId,
          mockBusinessId,
          mockFirebaseUid,
          mockUserId,
          {},
        ),
      ).rejects.toThrow(NotFoundException);

      expect(mockSaleModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: mockSaleId,
        }),
      );
    });

    it('deve lançar BadRequestException se venda está cancelada', async () => {
      const cancelledSale = {
        _id: new Types.ObjectId(mockSaleId),
        status: SaleStatus.CANCELADA,
        businessId: new Types.ObjectId(mockBusinessId),
        items: [],
        total: 100,
        payments: [],
      };

      mockSaleModel.findOne.mockReturnValueOnce(query(cancelledSale));

      await expect(
        service.update(
          mockSaleId,
          mockBusinessId,
          mockFirebaseUid,
          mockUserId,
          {},
        ),
      ).rejects.toThrow(
        new BadRequestException('Não é possível editar uma venda cancelada'),
      );
    });
  });

  describe('update() - Validação de Data', () => {
    it('deve lançar erro se createdAt é data inválida', async () => {
      const sale = {
        _id: new Types.ObjectId(mockSaleId),
        status: SaleStatus.CONCLUIDA,
        businessId: new Types.ObjectId(mockBusinessId),
        items: [],
        total: 100,
        payments: [],
      };

      mockSaleModel.findOne.mockReturnValueOnce(query(sale));

      await expect(
        service.update(
          mockSaleId,
          mockBusinessId,
          mockFirebaseUid,
          mockUserId,
          {
            createdAt: 'data-invalida',
          },
        ),
      ).rejects.toThrow(new BadRequestException('Data inválida'));
    });

    it('deve lançar erro se createdAt é futuro', async () => {
      const sale = {
        _id: new Types.ObjectId(mockSaleId),
        status: SaleStatus.CONCLUIDA,
        businessId: new Types.ObjectId(mockBusinessId),
        items: [],
        total: 100,
        payments: [],
      };

      mockSaleModel.findOne.mockReturnValueOnce(query(sale));

      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      await expect(
        service.update(
          mockSaleId,
          mockBusinessId,
          mockFirebaseUid,
          mockUserId,
          {
            createdAt: futureDate.toISOString(),
          },
        ),
      ).rejects.toThrow(
        new BadRequestException('A data da venda não pode ser no futuro'),
      );
    });
  });

  describe('update() - Validação de Pagamentos', () => {
    it('deve lançar erro se soma de pagamentos não corresponde ao total recalculado', async () => {
      const sale = {
        _id: new Types.ObjectId(mockSaleId),
        status: SaleStatus.CONCLUIDA,
        businessId: new Types.ObjectId(mockBusinessId),
        items: [
          {
            productId: new Types.ObjectId(mockProductId),
            productName: 'Produto teste',
            unitPrice: 25.9,
            quantity: 2,
            subtotal: 51.8,
            profit: 10,
            comboComponents: [],
          },
        ],
        total: 51.8,
        totalProfit: 10,
        payments: [{ method: 'DINHEIRO', amount: 51.8 }],
      };

      const product = {
        _id: new Types.ObjectId(mockProductId),
        name: 'Produto teste',
        costPrice: 10,
        pricingId: null,
        stock: 10,
        isCombo: false,
        comboItems: [],
      };

      mockSaleModel.findOne.mockReturnValueOnce(query(sale));
      mockProductModel.find.mockReturnValueOnce(query([product]));

      // Tenta atualizar com pagamento incorreto
      await expect(
        service.update(
          mockSaleId,
          mockBusinessId,
          mockFirebaseUid,
          mockUserId,
          {
            items: [
              {
                productId: mockProductId,
                unitPrice: 30.0,
                quantity: 2, // novo total: 60.00
              },
            ],
            payments: [{ method: 'DINHEIRO', amount: 51.8 }], // ainda 51.80
          },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve validar sucesso se soma de pagamentos equals novo total', async () => {
      const mockProduct = {
        _id: new Types.ObjectId(mockProductId),
        name: 'Produto teste',
        costPrice: 10,
        pricingId: null,
        stock: 10,
        isCombo: false,
        comboItems: [],
      };

      const sale = {
        _id: new Types.ObjectId(mockSaleId),
        status: SaleStatus.CONCLUIDA,
        businessId: new Types.ObjectId(mockBusinessId),
        items: [
          {
            productId: mockProduct._id,
            productName: mockProduct.name,
            unitPrice: 25.9,
            quantity: 2,
            subtotal: 51.8,
            profit: 31.8,
            costPrice: 10,
            comboComponents: [],
          },
        ],
        total: 51.8,
        totalProfit: 31.8,
        payments: [{ method: 'DINHEIRO', amount: 51.8 }],
      };

      // 1ª chamada: a venda a editar (via `.exec()`).
      // 2ª chamada: o retorno de `this.findOne()` (via `.populate().exec()`).
      mockSaleModel.findOne
        .mockReturnValueOnce(query(sale))
        .mockReturnValue(query(sale));
      mockProductModel.find.mockReturnValueOnce(query([mockProduct]));
      mockPricingsService.findManyByIds.mockResolvedValueOnce([]);
      mockUserModel.findOne.mockReturnValueOnce(
        query({ _id: mockUserId, displayName: 'Test User' }),
      );

      // Calcula novo total corretamente: 30 * 2 = 60
      await service.update(
        mockSaleId,
        mockBusinessId,
        mockFirebaseUid,
        mockUserId,
        {
          items: [
            {
              productId: mockProductId.toString(),
              unitPrice: 30.0,
              quantity: 2,
            },
          ],
          payments: [{ method: 'DINHEIRO', amount: 60.0 }],
        },
      );

      // Espera que findByIdAndUpdate tenha sido chamado
      expect(mockSaleModel.findByIdAndUpdate).toHaveBeenCalled();
    });
  });

  describe('update() - Ajustes de Estoque', () => {
    it('deve gerar StockMovement quando quantidade muda', async () => {
      const mockProduct = {
        _id: new Types.ObjectId(mockProductId),
        name: 'Produto teste',
        costPrice: 10,
        pricingId: null,
        stock: 10,
        isCombo: false,
        comboItems: [],
      };

      const sale = {
        _id: new Types.ObjectId(mockSaleId),
        status: SaleStatus.CONCLUIDA,
        businessId: new Types.ObjectId(mockBusinessId),
        items: [
          {
            productId: mockProduct._id,
            productName: mockProduct.name,
            unitPrice: 25.9,
            quantity: 2, // quantidade antiga
            subtotal: 51.8,
            profit: 31.8,
            costPrice: 10,
            comboComponents: [],
          },
        ],
        total: 51.8,
        totalProfit: 31.8,
        payments: [{ method: 'DINHEIRO', amount: 60.0 }],
      };

      mockSaleModel.findOne
        .mockReturnValueOnce(query(sale))
        .mockReturnValue(query(sale));

      mockProductModel.find.mockReturnValueOnce(query([mockProduct]));
      mockProductModel.findById.mockReturnValueOnce(query(mockProduct));
      mockProductModel.updateOne.mockResolvedValueOnce({});

      mockUserModel.findOne.mockReturnValueOnce(
        query({ _id: mockUserId, displayName: 'Test User' }),
      );

      mockPricingsService.findManyByIds.mockResolvedValueOnce([]);
      mockStockMovementsService.recordSaleMovement.mockResolvedValueOnce(null);

      // Nova quantidade: 5 (delta = +3)
      await service.update(
        mockSaleId,
        mockBusinessId,
        mockFirebaseUid,
        mockUserId,
        {
          items: [
            {
              productId: mockProductId.toString(),
              unitPrice: 25.9,
              quantity: 5,
            },
          ],
          payments: [{ method: 'DINHEIRO', amount: 129.5 }],
        },
      );

      // Verifica se StockMovement foi registrado
      expect(mockStockMovementsService.recordSaleMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MovementType.AJUSTE,
          quantity: 3, // |5 - 2|
        }),
        10, // previousStock
        7, // newStock = 10 - 3
      );
    });
  });
});
