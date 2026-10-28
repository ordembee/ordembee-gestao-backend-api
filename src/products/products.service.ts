import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { StorageService } from '../storage/storage.service';
import { PricingsService } from '../pricings/pricings.service';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    private readonly storageService: StorageService,
    private readonly pricingsService: PricingsService,
  ) {}

  /** Sobrepõe costPrice com o valor calculado em tempo real pela precificação
   * vinculada (quando houver), sem persistir nada — mesmo princípio de
   * "sempre em tempo real na leitura" usado em ingredients/pricings. Chamado
   * em TODO caminho que retorna um Product para o frontend (create/findAll/
   * findOne/update/uploadImage) para nunca deixar vazar um costPrice estático
   * desatualizado quando há vínculo ativo. */
  private async attachLinkedPricing(
    businessId: string,
    products: ProductDocument[],
  ): Promise<any[]> {
    const pricingIds = products
      .filter((p) => p.pricingId)
      .map((p) => p.pricingId as Types.ObjectId);
    const pricings = await this.pricingsService.findManyByIds(
      businessId,
      pricingIds,
    );
    const byId = new Map(pricings.map((p) => [p._id.toString(), p]));

    return products.map((p) => {
      const obj: any = p.toObject();
      const linked = p.pricingId ? byId.get(p.pricingId.toString()) : undefined;
      if (linked && linked.custoFinal !== null) {
        obj.costPrice = linked.custoFinal;
        obj.linkedPricing = {
          _id: linked._id,
          name: linked.name,
          precoVenda: linked.precoVenda,
        };
      } else {
        obj.linkedPricing = null;
      }
      return obj;
    });
  }

  /** Garante que a precificação existe/está ativa e que nenhum outro produto
   * ativo já a usa. `excludeProductId` permite re-salvar o mesmo produto já
   * vinculado sem trombar com ele mesmo. */
  private async assertPricingLink(
    bizObj: Types.ObjectId,
    pricingId: string,
    isCombo: boolean,
    excludeProductId?: string,
  ): Promise<Types.ObjectId> {
    if (isCombo) {
      throw new BadRequestException(
        'Não é possível vincular uma precificação a um produto combo',
      );
    }
    const exists = await this.pricingsService.existsActive(
      bizObj.toString(),
      pricingId,
    );
    if (!exists) {
      throw new NotFoundException('Precificação não encontrada ou inativa');
    }

    const pricingIdObj = new Types.ObjectId(pricingId);
    const conflict = await this.productModel.exists({
      businessId: bizObj,
      pricingId: pricingIdObj,
      isActive: true,
      ...(excludeProductId
        ? { _id: { $ne: new Types.ObjectId(excludeProductId) } }
        : {}),
    });
    if (conflict) {
      throw new ConflictException(
        'Esta precificação já está vinculada a outro produto ativo',
      );
    }
    return pricingIdObj;
  }

  async create(businessId: string, dto: CreateProductDto): Promise<any> {
    const bizObj = new Types.ObjectId(businessId);
    const data: any = {
      ...dto,
      businessId: bizObj,
    };
    // Nunca deixa `pricingId` ser gravado como `null` literal (o índice único
    // parcial considera o campo "existente" mesmo com valor null, o que
    // quebraria a unicidade entre produtos não vinculados). Ausente = OK.
    delete data.pricingId;
    if (dto.categoryId) data.categoryId = new Types.ObjectId(dto.categoryId);
    if (dto.isCombo) {
      data.stock = -1;
      data.comboItems = (dto.comboItems ?? []).map((ci) => ({
        productId: new Types.ObjectId(ci.productId),
        quantity: ci.quantity,
        productName: ci.productName,
      }));
    }
    if (dto.pricingId) {
      data.pricingId = await this.assertPricingLink(
        bizObj,
        dto.pricingId,
        !!dto.isCombo,
      );
    }

    const product = await this.productModel.create(data);
    this.logger.log(
      `Produto criado: ${product._id.toString()} | negócio: ${businessId} | nome: "${dto.name}"`,
    );
    const [resolved] = await this.attachLinkedPricing(businessId, [product]);
    return resolved;
  }

  async findAll(
    businessId: string,
    search?: string,
    categoryId?: string,
    includeInactive?: boolean,
  ): Promise<any[]> {
    this.logger.log(
      `Listando produtos: negócio: ${businessId} | search: "${search || ''}" | categoryId: ${categoryId || 'todos'} | includeInactive: ${includeInactive}`,
    );

    const filter: any = {
      businessId: new Types.ObjectId(businessId),
      ...(includeInactive ? {} : { isActive: true }),
    };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
      ];
    }

    if (categoryId) filter.categoryId = new Types.ObjectId(categoryId);

    const products = await this.productModel
      .find(filter)
      .populate('categoryId', 'name color icon')
      .sort({ name: 1 })
      .exec();
    return this.attachLinkedPricing(businessId, products);
  }

  async findOne(id: string, businessId: string): Promise<any> {
    const product = await this.productModel
      .findOne({ _id: id, businessId: new Types.ObjectId(businessId) })
      .populate('categoryId', 'name color icon')
      .exec();
    if (!product) {
      this.logger.warn(
        `Produto não encontrado: id=${id} | negócio: ${businessId}`,
      );
      throw new NotFoundException('Produto não encontrado');
    }
    const [resolved] = await this.attachLinkedPricing(businessId, [product]);
    return resolved;
  }

  async update(
    id: string,
    businessId: string,
    dto: UpdateProductDto,
  ): Promise<any> {
    const bizObj = new Types.ObjectId(businessId);
    const existing = await this.productModel.findOne({
      _id: id,
      businessId: bizObj,
    });
    if (!existing) {
      this.logger.warn(
        `Tentativa de atualizar produto inexistente: id=${id} | negócio: ${businessId}`,
      );
      throw new NotFoundException('Produto não encontrado');
    }

    const update: any = { ...dto };
    delete update.pricingId;
    if (dto.categoryId) update.categoryId = new Types.ObjectId(dto.categoryId);
    if (dto.isCombo) {
      update.stock = -1;
      if (dto.comboItems) {
        update.comboItems = dto.comboItems.map((ci) => ({
          productId: new Types.ObjectId(ci.productId!),
          quantity: ci.quantity,
          productName: ci.productName,
        }));
      }
    }

    let unset: any;
    let willBeLinked = !!existing.pricingId;
    if (dto.pricingId !== undefined) {
      if (dto.pricingId === null) {
        unset = { pricingId: '' };
        willBeLinked = false;
      } else {
        const isCombo = dto.isCombo ?? existing.isCombo;
        update.pricingId = await this.assertPricingLink(
          bizObj,
          dto.pricingId,
          isCombo,
          id,
        );
        willBeLinked = true;
      }
    }

    // costPrice de um produto vinculado é sempre derivado da precificação —
    // nunca deixa um valor manual/desatualizado sobrescrever o vínculo.
    if (update.costPrice !== undefined && willBeLinked) {
      delete update.costPrice;
    }

    const product = await this.productModel
      .findOneAndUpdate(
        { _id: id, businessId: bizObj },
        {
          ...(Object.keys(update).length ? { $set: update } : {}),
          ...(unset ? { $unset: unset } : {}),
        },
        { new: true },
      )
      .populate('categoryId', 'name color icon')
      .exec();
    if (!product) {
      throw new NotFoundException('Produto não encontrado');
    }
    this.logger.log(`Produto atualizado: ${id} | negócio: ${businessId}`);
    const [resolved] = await this.attachLinkedPricing(businessId, [product]);
    return resolved;
  }

  async uploadImage(
    id: string,
    businessId: string,
    file: Express.Multer.File,
  ): Promise<any> {
    const product = await this.findOne(id, businessId);
    const imageUrl = await this.storageService.uploadProductImage(
      businessId,
      product._id.toString(),
      file,
    );
    const updated = await this.productModel
      .findByIdAndUpdate(id, { imageUrl }, { new: true })
      .populate('categoryId', 'name color icon')
      .exec();
    this.logger.log(`Imagem atualizada: produto=${id} | negócio=${businessId}`);
    const [resolved] = await this.attachLinkedPricing(businessId, [updated!]);
    return resolved;
  }

  async remove(id: string, businessId: string): Promise<void> {
    const result = await this.productModel
      .findOneAndUpdate(
        { _id: id, businessId: new Types.ObjectId(businessId) },
        { isActive: false },
        { new: true },
      )
      .exec();
    if (!result) {
      this.logger.warn(
        `Tentativa de remover produto inexistente: id=${id} | negócio: ${businessId}`,
      );
      throw new NotFoundException('Produto não encontrado');
    }
    this.logger.log(
      `Produto desativado (soft delete): ${id} | negócio: ${businessId}`,
    );
  }
}
