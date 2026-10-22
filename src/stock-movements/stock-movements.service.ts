import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { StockMovement, StockMovementDocument, MovementType } from './schemas/stock-movement.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { BusinessService } from '../business/business.service';
import { instantRangeFilter } from '../common/date/timezone.util';

export interface InternalMovementPayload {
  productId: Types.ObjectId;
  productName: string;
  businessId: Types.ObjectId;
  /** Ausente quando a movimentacao nasce fora de um usuario (pedido do cardapio). */
  userId?: Types.ObjectId;
  type: MovementType;
  quantity: number;
  reason?: string;
  saleId?: Types.ObjectId;
  orderId?: Types.ObjectId;
}

@Injectable()
export class StockMovementsService {
  private readonly logger = new Logger(StockMovementsService.name);

  constructor(
    @InjectModel(StockMovement.name)
    private readonly movementModel: Model<StockMovementDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly businessService: BusinessService,
  ) {}

  async createManual(
    firebaseUid: string,
    businessId: string,
    dto: CreateStockMovementDto,
  ): Promise<StockMovementDocument> {
    const [user, product] = await Promise.all([
      this.userModel.findOne({ firebaseUid }).exec(),
      this.productModel
        .findOne({ _id: dto.productId, businessId: new Types.ObjectId(businessId) })
        .exec(),
    ]);

    if (!user) throw new NotFoundException('Usuário não encontrado');
    if (!product) throw new NotFoundException('Produto não encontrado');

    const previousStock = product.stock;

    let newStock: number;
    if (previousStock === -1) {
      if (dto.newStock !== undefined) {
        newStock = dto.newStock;
      } else if (dto.type === MovementType.ENTRADA) {
        // Produto sem estoque definido: entrada inicia o rastreamento a partir de 0
        newStock = dto.quantity;
      } else {
        newStock = -1;
      }
    } else {
      switch (dto.type) {
        case MovementType.ENTRADA:
          newStock = previousStock + dto.quantity;
          break;
        case MovementType.SAIDA:
        case MovementType.DESPERDICIO:
          newStock = Math.max(0, previousStock - dto.quantity);
          break;
        case MovementType.AJUSTE:
          newStock = dto.newStock !== undefined ? dto.newStock : previousStock;
          break;
        default:
          newStock = previousStock;
      }
    }

    await this.productModel.updateOne(
      { _id: product._id },
      { $set: { stock: newStock } },
    );

    const movement = await this.movementModel.create({
      productId: product._id,
      productName: product.name,
      businessId: new Types.ObjectId(businessId),
      userId: user._id,
      type: dto.type,
      quantity: dto.quantity,
      reason: dto.reason,
      previousStock,
      newStock,
    });

    this.logger.log(
      `Movimentação manual: ${dto.type} | produto: ${product.name} | qty: ${dto.quantity} | ${previousStock} → ${newStock}`,
    );
    return movement;
  }

  async recordSaleMovement(payload: InternalMovementPayload, previousStock: number, newStock: number): Promise<void> {
    await this.movementModel.create({
      productId: payload.productId,
      productName: payload.productName,
      businessId: payload.businessId,
      userId: payload.userId,
      type: payload.type,
      quantity: payload.quantity,
      reason: payload.reason,
      saleId: payload.saleId,
      orderId: payload.orderId,
      previousStock,
      newStock,
    });
  }

  async findAll(
    businessId: string,
    params: {
      productId?: string;
      type?: string;
      dateFrom?: string;
      dateTo?: string;
      page: number;
      limit: number;
    },
  ): Promise<{ data: StockMovementDocument[]; total: number; totalPages: number }> {
    const { productId, type, dateFrom, dateTo, page, limit } = params;

    const filter: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
    };

    if (productId) filter.productId = new Types.ObjectId(productId);
    if (type) filter.type = type;

    const tz = await this.businessService.getTimezone(businessId);
    const dateFilter = instantRangeFilter(dateFrom, dateTo, tz);
    if (dateFilter) filter.createdAt = dateFilter;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.movementModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'displayName email')
        .exec(),
      this.movementModel.countDocuments(filter).exec(),
    ]);

    return { data, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }
}
