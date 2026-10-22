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
  Business,
  BusinessDocument,
} from '../business/schemas/business.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Customer,
  CustomerDocument,
} from '../customers/schemas/customer.schema';
import { OrdersService } from '../orders/orders.service';
import { OrderFulfillment } from '../orders/schemas/order.schema';
import { PaymentMethod } from '../common/enums/payment-method.enum';
import { resolveTimeZone } from '../common/date/timezone.util';
import {
  MAX_ITEMS_PER_ORDER,
  MAX_UNITS_PER_PRODUCT,
  MenuOrderDto,
} from './dto/menu-order.dto';
import { isOpenAt } from './menu-hours.util';
import {
  MENU_PRODUCT_FIELDS,
  MenuSourceProduct,
  StockIndex,
  comboComponentIds,
  isProductAvailable,
  indexMenuItems,
  isProductOnMenu,
  menuPrice,
  resolveOptionGroups,
  MenuSnapshotOptionGroup,
} from './menu-snapshot';

/** Motivos de recusa que o my-store-cardapio-web-back-api traduz para o cliente. */
export type MenuOrderRejection =
  | 'STORE_CLOSED'
  | 'PRODUCT_UNAVAILABLE'
  | 'MENU_DISABLED'
  | 'INSUFFICIENT_STOCK'
  | 'STORE_BUSY';

/**
 * Teto de pedidos do cardapio por loja na ultima hora, contado no banco (vale
 * para todas as instancias, ao contrario do throttler em memoria). Segura uma
 * rajada de pedidos falsos trocando IP e telefone; alto para nao barrar dia cheio.
 */
export const MAX_MENU_ORDERS_PER_STORE_PER_HOUR = 40;

const reject = (reason: MenuOrderRejection, message: string) =>
  new ConflictException({ statusCode: 409, reason, message });

/**
 * Confere os complementos marcados contra os grupos do item e devolve o que
 * vai gravado no pedido. Regras: so opcoes dos grupos do item, cada uma uma
 * vez, e a quantidade por grupo entre `min` e `max`.
 */
export function resolveChosenOptions(
  productName: string,
  groups: MenuSnapshotOptionGroup[],
  chosen: { groupId: string; optionId: string }[],
): { groupName: string; name: string; price: number }[] {
  const invalid = (message: string) =>
    new BadRequestException({
      statusCode: 400,
      reason: 'INVALID_OPTIONS',
      message,
    });
  const byGroup = new Map(groups.map((g) => [g.id, g]));
  const seen = new Set<string>();
  const countByGroup = new Map<string, number>();
  const result: { groupName: string; name: string; price: number }[] = [];

  for (const c of chosen) {
    const group = byGroup.get(c.groupId);
    const option = group?.options.find((o) => o.id === c.optionId);
    if (!group || !option) {
      throw invalid(
        `Complemento indisponível em ${productName}. Atualize o cardápio.`,
      );
    }
    const key = `${c.groupId}:${c.optionId}`;
    if (seen.has(key)) throw invalid(`Complemento repetido em ${productName}`);
    seen.add(key);
    countByGroup.set(group.id, (countByGroup.get(group.id) ?? 0) + 1);
    result.push({
      groupName: group.name,
      name: option.name,
      price: option.price,
    });
  }

  for (const group of groups) {
    const count = countByGroup.get(group.id) ?? 0;
    if (count < group.min) {
      throw invalid(
        `Escolha ${group.min === 1 ? 'uma opção' : `${group.min} opções`} em “${group.name}” (${productName})`,
      );
    }
    if (count > group.max) {
      throw invalid(
        `Escolha no máximo ${group.max} em “${group.name}” (${productName})`,
      );
    }
  }
  return result;
}

/** '11987654321' -> '(11) 98765-4321' — mesmo formato digitado no cadastro de clientes. */
export function formatPhone(digits: string): string {
  const ddd = digits.slice(0, 2);
  const rest = digits.slice(2);
  const split = rest.length === 9 ? 5 : 4;
  return `(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
}

/** Regex que acha o telefone independentemente da mascara gravada ("(11) 9...", "11 9...", "119..."). */
export function phoneDigitsPattern(digits: string): RegExp {
  return new RegExp(`^\\D*${digits.split('').join('\\D*')}\\D*$`);
}

export function formatAddress(a: NonNullable<MenuOrderDto['address']>): string {
  const line1 = [`${a.street}, ${a.number}`, a.complement]
    .filter(Boolean)
    .join(' – ');
  const line2 = [a.district, a.cep && `CEP ${a.cep}`]
    .filter(Boolean)
    .join(' · ');
  return [line1, line2, a.reference && `Ref.: ${a.reference}`]
    .filter(Boolean)
    .join('\n');
}

/**
 * Pedido do cardapio digital, recebido pela rota interna assinada. Tudo e
 * revalidado aqui (defesa em profundidade), mesmo que o my-store-cardapio-web-back-api ja
 * tenha validado contra o JSON publicado: o banco e a fonte da verdade —
 * inclusive dos precos.
 */
@Injectable()
export class MenuOrdersService {
  private readonly logger = new Logger(MenuOrdersService.name);

  constructor(
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
    private readonly ordersService: OrdersService,
  ) {}

  /** Estoque dos produtos do pedido + dos componentes dos combos. */
  private async stocksFor(
    businessId: Types.ObjectId,
    products: MenuSourceProduct[],
  ): Promise<StockIndex> {
    const stocks: StockIndex = new Map(
      products.map((p) => [String(p._id), p.stock ?? -1]),
    );
    const missing = comboComponentIds(products).filter((id) => !stocks.has(id));
    if (missing.length) {
      const components = await this.productModel
        .find({ businessId, _id: { $in: missing } })
        .select('stock')
        .lean<{ _id: unknown; stock?: number }[]>()
        .exec();
      for (const c of components) stocks.set(String(c._id), c.stock ?? -1);
    }
    return stocks;
  }

  /**
   * Checagem rapida (a trava de verdade e a baixa condicional em
   * OrdersService.reserveStock): soma o pedido por produto — linhas repetidas
   * e combos contam juntos — e compara com o que da para vender. A mensagem
   * nunca diz quanto resta.
   */
  private assertStockFits(
    items: MenuOrderDto['items'],
    byId: Map<string, MenuSourceProduct>,
    stocks: StockIndex,
  ): void {
    const wanted = new Map<string, number>();
    const add = (id: string, qty: number) =>
      wanted.set(id, (wanted.get(id) ?? 0) + qty);
    for (const item of items) {
      const product = byId.get(item.productId)!;
      if (product.isCombo) {
        for (const c of product.comboItems ?? []) {
          add(String(c.productId), c.quantity * item.quantity);
        }
      } else {
        add(item.productId, item.quantity);
      }
    }
    for (const [id, qty] of wanted) {
      const stock = stocks.get(id);
      if (stock === undefined || stock === -1) continue;
      if (Math.max(0, stock) < qty) {
        const name =
          items
            .map((i) => byId.get(i.productId)!)
            .find(
              (p) =>
                String(p._id) === id ||
                (p.isCombo &&
                  (p.comboItems ?? []).some((c) => String(c.productId) === id)),
            )?.name ?? 'um item';
        throw reject('INSUFFICIENT_STOCK', `Quantidade indisponível para ${name}`);
      }
    }
  }

  private async findOrCreateCustomer(
    businessId: Types.ObjectId,
    customer: MenuOrderDto['customer'],
    address: string | undefined,
  ): Promise<CustomerDocument> {
    const existing = await this.customerModel
      .findOne({
        businessId,
        isActive: true,
        phone: { $regex: phoneDigitsPattern(customer.phone) },
      })
      .exec();
    if (existing) {
      // Completa o cadastro sem sobrescrever o que a loja ja registrou.
      if (address && !existing.address) {
        existing.address = address;
        await existing.save();
      }
      return existing;
    }
    const created = await this.customerModel.create({
      businessId,
      name: customer.name.trim(),
      phone: formatPhone(customer.phone),
      address,
      notes: 'Cadastrado pelo cardápio digital',
    });
    this.logger.log(
      `Cliente criado pelo cardápio: ${created._id.toString()} | negócio: ${businessId.toString()}`,
    );
    return created;
  }

  async create(
    dto: MenuOrderDto,
    now = new Date(),
  ): Promise<{ code: number; total: number }> {
    const business = await this.businessModel
      .findOne({ 'menu.slug': dto.slug })
      .select('timezone menu')
      .lean()
      .exec();
    if (!business) throw new NotFoundException('Cardápio não encontrado');

    const menu = business.menu;
    if (!menu?.enabled) throw reject('MENU_DISABLED', 'Cardápio desativado');
    if (
      menu.acceptedPayments?.length &&
      !menu.acceptedPayments.includes(dto.payment.method)
    ) {
      throw new BadRequestException(
        'Esta loja não aceita essa forma de pagamento',
      );
    }
    if (
      dto.fulfillment === OrderFulfillment.RETIRADA &&
      menu.pickupEnabled === false
    ) {
      throw new BadRequestException('Esta loja não aceita retirada');
    }
    if (
      dto.fulfillment === OrderFulfillment.ENTREGA &&
      menu.deliveryEnabled === false
    ) {
      throw new BadRequestException(
        'Esta loja não faz entrega — escolha retirar no local',
      );
    }
    if (!isOpenAt(menu.openingHours, resolveTimeZone(business.timezone), now)) {
      throw reject('STORE_CLOSED', 'Loja fechada no momento');
    }

    const businessId = business._id as Types.ObjectId;

    const perProduct = new Map<string, number>();
    for (const item of dto.items) {
      const units = (perProduct.get(item.productId) ?? 0) + item.quantity;
      if (units > MAX_UNITS_PER_PRODUCT) {
        throw new BadRequestException(
          `Máximo de ${MAX_UNITS_PER_PRODUCT} unidades de cada item por pedido`,
        );
      }
      perProduct.set(item.productId, units);
    }
    if (dto.items.reduce((sum, i) => sum + i.quantity, 0) > MAX_ITEMS_PER_ORDER) {
      throw new BadRequestException(
        `Cada pedido pode ter no máximo ${MAX_ITEMS_PER_ORDER} itens`,
      );
    }

    // Retry de um pedido que ja entrou: devolve o mesmo, sem revalidar (o
    // estoque ja foi baixado por ele).
    const already = await this.ordersService.findMenuOrderByRef(
      businessId.toString(),
      dto.orderRef,
    );
    if (already) return already;

    const lastHour = await this.ordersService.countMenuOrdersSince(
      businessId.toString(),
      new Date(now.getTime() - 60 * 60 * 1000),
    );
    if (lastHour >= MAX_MENU_ORDERS_PER_STORE_PER_HOUR) {
      this.logger.warn(
        `Teto de pedidos do cardápio por hora atingido: negócio=${businessId.toString()} | ${lastHour} na última hora`,
      );
      throw reject(
        'STORE_BUSY',
        'A loja está recebendo muitos pedidos agora. Tente de novo em alguns minutos ou fale com a loja pelo WhatsApp.',
      );
    }

    const products = await this.productModel
      .find({
        _id: { $in: dto.items.map((i) => new Types.ObjectId(i.productId)) },
        businessId,
      })
      .select(MENU_PRODUCT_FIELDS)
      .lean<MenuSourceProduct[]>()
      .exec();
    const byId = new Map(products.map((p) => [String(p._id), p]));
    const menuItems = indexMenuItems(menu.items);
    const stocks = await this.stocksFor(businessId, products);

    const items = dto.items.map((item) => {
      const product = byId.get(item.productId);
      if (
        !product ||
        !isProductOnMenu(product, menuItems.get(item.productId)) ||
        !isProductAvailable(product, stocks)
      ) {
        throw reject(
          'PRODUCT_UNAVAILABLE',
          `Produto indisponível: ${product?.name ?? item.productId}`,
        );
      }
      const options = resolveChosenOptions(
        product.name,
        resolveOptionGroups(menuItems.get(item.productId), menu.optionGroups),
        item.options ?? [],
      );
      const optionsTotal = options.reduce((sum, o) => sum + o.price, 0);
      return {
        productId: item.productId,
        // Preco do item = preco cadastrado + complementos, tudo do banco.
        unitPrice:
          Math.round((menuPrice(product)!.value + optionsTotal) * 100) / 100,
        quantity: item.quantity,
        notes: item.notes?.trim() || undefined,
        options,
      };
    });

    this.assertStockFits(dto.items, byId, stocks);

    const deliveryFee =
      dto.fulfillment === OrderFulfillment.ENTREGA
        ? (menu.deliveryFee ?? 0)
        : 0;
    const estimatedTotal =
      items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) + deliveryFee;
    const { payment } = dto;
    if (
      payment.method === PaymentMethod.DINHEIRO &&
      payment.changeFor !== undefined &&
      // Mesma regra do my-store-cardapio-web-back-api: troco "para" o valor exato nao faz sentido.
      payment.changeFor <= estimatedTotal
    ) {
      throw new BadRequestException(
        'O troco deve ser para um valor maior que o total',
      );
    }

    const address =
      dto.fulfillment === OrderFulfillment.ENTREGA && dto.address
        ? formatAddress(dto.address)
        : undefined;
    const customer = await this.findOrCreateCustomer(
      businessId,
      dto.customer,
      address,
    );

    const order = await this.ordersService.createFromMenu({
      businessId: businessId.toString(),
      externalRef: dto.orderRef,
      customer,
      items,
      fulfillment: dto.fulfillment,
      deliveryFee,
      customerAddress: address,
      requestedPayment: {
        method: payment.method,
        brand: payment.brand,
        changeFor:
          payment.method === PaymentMethod.DINHEIRO
            ? payment.changeFor
            : undefined,
      },
      notes: 'Pedido feito pelo cardápio digital',
    });

    return { code: order.code, total: order.total };
  }
}
