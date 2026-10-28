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
  PixSettings,
} from '../business/schemas/business.schema';
import {
  DeliveryProvider,
  MenuOnline,
  MenuOnlineDocument,
} from './schemas/menu-online.schema';
import { resolveMenu } from './menu.service';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Customer,
  CustomerAddress,
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
import { buildPixBrCode } from '../common/pix/pix-brcode';
import { UberDirectService } from '../delivery/uber-direct.service';
import {
  InfinitePayService,
  infinitePayActive,
} from '../payments/infinitepay.service';
import {
  StructuredAddress,
  formatStructuredAddress,
  toE164BR,
} from '../delivery/uber-direct.util';
import type { OrderDelivery } from '../orders/schemas/order.schema';
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
  | 'QUOTE_REQUIRED'
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

/**
 * Resposta ao my-store-cardapio-web-back-api. Pagamento antecipado: `checkoutUrl`
 * (InfinitePay) ou `pix` (copia e cola estatico). Com a InfinitePay ativa e o
 * link ainda sem sair, `onlinePayment` avisa que o link deve ser pedido depois.
 */
export interface MenuOrderResult {
  code: number;
  total: number;
  ref: string;
  pix?: { payload: string; amount: number };
  checkoutUrl?: string;
  onlinePayment?: 'INFINITEPAY';
}

/** Pix copia-e-cola do pedido (txid = numero do pedido, para achar no extrato). */
export function pixForOrder(
  pix: PixSettings,
  code: number,
  total: number,
): { payload: string; amount: number } {
  return {
    amount: total,
    payload: buildPixBrCode({
      key: pix.key,
      merchantName: pix.merchantName,
      merchantCity: pix.merchantCity,
      amount: total,
      txid: `PEDIDO${code}`,
    }),
  };
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

/** Endereco do pedido, campo a campo, para o cadastro do cliente. */
function toCustomerAddress(
  a: NonNullable<MenuOrderDto['address']>,
): CustomerAddress {
  const opt = (v?: string) => v?.trim() || undefined;
  return {
    cep: opt(a.cep),
    street: a.street.trim(),
    number: a.number.trim(),
    district: a.district.trim(),
    city: opt(a.city),
    state: opt(a.state)?.toUpperCase(),
    complement: opt(a.complement),
    reference: opt(a.reference),
  };
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
    @InjectModel(MenuOnline.name)
    private readonly menuModel: Model<MenuOnlineDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
    private readonly ordersService: OrdersService,
    private readonly uberDirect: UberDirectService,
    private readonly infinitePay: InfinitePayService,
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
        throw reject(
          'INSUFFICIENT_STOCK',
          `Quantidade indisponível para ${name}`,
        );
      }
    }
  }

  private async findOrCreateCustomer(
    businessId: Types.ObjectId,
    customer: MenuOrderDto['customer'],
    address: string | undefined,
    addressDetails: CustomerAddress | undefined,
  ): Promise<CustomerDocument> {
    const existing = await this.customerModel
      .findOne({
        businessId,
        isActive: true,
        phone: { $regex: phoneDigitsPattern(customer.phone) },
      })
      .exec();
    if (existing) {
      // Endereco de entrega: vale o do pedido mais recente.
      if (address && address !== existing.address) {
        existing.address = address;
        existing.addressDetails = addressDetails;
        await existing.save();
        this.logger.log(
          `Endereço do cliente atualizado pelo cardápio: ${existing._id.toString()} | negócio: ${businessId.toString()}`,
        );
      } else if (address && addressDetails && !existing.addressDetails) {
        existing.addressDetails = addressDetails;
        await existing.save();
      }
      return existing;
    }
    const created = await this.customerModel.create({
      businessId,
      name: customer.name.trim(),
      phone: formatPhone(customer.phone),
      address,
      addressDetails,
      notes: 'Cadastrado pelo cardápio digital',
    });
    this.logger.log(
      `Cliente criado pelo cardápio: ${created._id.toString()} | negócio: ${businessId.toString()}`,
    );
    return created;
  }

  /**
   * Entrega pela Uber: endereco completo, destinatario, Pix antecipado e a
   * cotacao que o cliente viu. Devolve o bloco `delivery` do pedido.
   */
  private async prepareUberDelivery(
    businessId: Types.ObjectId,
    dto: MenuOrderDto,
    pix: PixSettings | undefined,
    online: boolean,
  ): Promise<{
    delivery: OrderDelivery;
    fee: number;
    address: StructuredAddress;
  }> {
    if (dto.payment.method !== PaymentMethod.PIX) {
      throw new BadRequestException('Entrega pela Uber é paga antes, por Pix');
    }
    if (!online && !pix?.key) {
      this.logger.error(
        `Loja em modo Uber sem chave Pix: ${businessId.toString()}`,
      );
      throw reject(
        'MENU_DISABLED',
        'A loja não está recebendo pedidos com entrega agora',
      );
    }
    const a = dto.address!;
    if (!a.cep || !a.city || !a.state) {
      throw new BadRequestException('Informe CEP, cidade e estado da entrega');
    }
    const recipient = dto.recipient ?? dto.customer;
    if (recipient.name.trim().split(/\s+/).length < 2) {
      throw new BadRequestException(
        'Informe nome e sobrenome de quem vai receber',
      );
    }
    const phone = toE164BR(recipient.phone);
    if (!phone)
      throw new BadRequestException('Telefone de quem recebe inválido');
    if (!dto.quoteId) {
      throw reject(
        'QUOTE_REQUIRED',
        'Calcule a taxa de entrega antes de enviar o pedido',
      );
    }
    const address: StructuredAddress = {
      cep: a.cep,
      street: a.street.trim(),
      number: a.number.trim(),
      district: a.district.trim(),
      city: a.city.trim(),
      state: a.state.toUpperCase(),
      complement: a.complement?.trim() || undefined,
    };
    const quote = await this.uberDirect.acceptMenuQuote(
      businessId,
      dto.quoteId,
      address,
    );
    return {
      fee: quote.fee,
      address,
      delivery: {
        provider: 'UBER',
        quoteId: quote.quoteId,
        quotedFee: quote.fee,
        dropoff: address,
        recipientName: recipient.name.trim(),
        recipientPhone: phone,
        instructions:
          [
            a.instructions?.trim(),
            a.reference?.trim() && `Ref.: ${a.reference.trim()}`,
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
        events: [],
      },
    };
  }

  async claimPayment(slug: string, ref: string) {
    const menu = await this.menuModel
      .findOne({ slug })
      .select('businessId')
      .lean()
      .exec();
    if (!menu) throw new NotFoundException('Cardápio não encontrado');
    return this.ordersService.claimMenuPayment(String(menu.businessId), ref);
  }

  async create(dto: MenuOrderDto, now = new Date()): Promise<MenuOrderResult> {
    const doc = await this.menuModel
      .findOne({ slug: dto.slug })
      .lean<MenuOnline>()
      .exec();
    const business = doc
      ? await this.businessModel
          .findById(doc.businessId)
          .select('timezone config.pix config.infinitepay')
          .lean()
          .exec()
      : null;
    if (!doc || !business)
      throw new NotFoundException('Cardápio não encontrado');

    const menu = resolveMenu(doc);
    const { delivery } = menu.store;
    const pix = business.config?.pix;
    const online = infinitePayActive(business.config?.infinitepay);
    if (!menu.enabled) throw reject('MENU_DISABLED', 'Cardápio desativado');
    const uberMode =
      dto.fulfillment === OrderFulfillment.ENTREGA &&
      delivery.deliveryProvider === DeliveryProvider.UBER;
    if (
      // Na Uber o pagamento e sempre Pix antecipado (conferido adiante).
      !uberMode &&
      menu.store.acceptedPayments.length &&
      !menu.store.acceptedPayments.includes(dto.payment.method)
    ) {
      throw new BadRequestException(
        'Esta loja não aceita essa forma de pagamento',
      );
    }
    if (
      dto.fulfillment === OrderFulfillment.RETIRADA &&
      !delivery.pickupEnabled
    ) {
      throw new BadRequestException('Esta loja não aceita retirada');
    }
    if (
      dto.fulfillment === OrderFulfillment.ENTREGA &&
      !delivery.deliveryEnabled
    ) {
      throw new BadRequestException(
        'Esta loja não faz entrega — escolha retirar no local',
      );
    }
    if (
      !isOpenAt(
        menu.store.openingHours,
        resolveTimeZone(business.timezone),
        now,
      )
    ) {
      throw reject('STORE_CLOSED', 'Loja fechada no momento');
    }

    const businessId = business._id;

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
    if (
      dto.items.reduce((sum, i) => sum + i.quantity, 0) > MAX_ITEMS_PER_ORDER
    ) {
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
    if (already) {
      return {
        code: already.code,
        total: already.total,
        ref: dto.orderRef,
        ...this.prepaidPayment(already, pix, online),
      };
    }

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

    const uber = uberMode
      ? await this.prepareUberDelivery(businessId, dto, pix, online)
      : null;
    const deliveryFee = uber
      ? uber.fee
      : dto.fulfillment === OrderFulfillment.ENTREGA
        ? delivery.deliveryFee
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

    const address = uber
      ? formatStructuredAddress(uber.address)
      : dto.fulfillment === OrderFulfillment.ENTREGA && dto.address
        ? formatAddress(dto.address)
        : undefined;
    const customer = await this.findOrCreateCustomer(
      businessId,
      dto.customer,
      address,
      address ? toCustomerAddress(dto.address!) : undefined,
    );

    const order = await this.ordersService.createFromMenu({
      businessId: businessId.toString(),
      externalRef: dto.orderRef,
      customer,
      items,
      fulfillment: dto.fulfillment,
      deliveryFee,
      customerAddress: address,
      customerEmail: dto.customer.email?.trim() || undefined,
      requestedPayment: {
        method: payment.method,
        brand: payment.brand,
        changeFor:
          payment.method === PaymentMethod.DINHEIRO
            ? payment.changeFor
            : undefined,
        prepaid: uber ? true : undefined,
      },
      delivery: uber?.delivery,
      notes: uber
        ? online
          ? 'Pedido feito pelo cardápio digital · entrega Uber · pagamento pela InfinitePay'
          : 'Pedido feito pelo cardápio digital · entrega Uber (Pix antecipado)'
        : 'Pedido feito pelo cardápio digital',
    });

    if (!uber)
      return { code: order.code, total: order.total, ref: dto.orderRef };
    if (online) {
      // Falha ao gerar o link nao derruba o pedido (ja existe, com estoque
      // reservado): o cardapio pede o link de novo.
      const checkout = await this.infinitePay
        .ensureCheckout(businessId.toString(), dto.orderRef, dto.redirectUrl)
        .catch((error: Error) => {
          this.logger.error(
            `Pedido #${order.code} sem link InfinitePay: ${error.message}`,
          );
          return null;
        });
      return {
        code: order.code,
        total: order.total,
        ref: dto.orderRef,
        ...(checkout
          ? { checkoutUrl: checkout.checkoutUrl }
          : { onlinePayment: 'INFINITEPAY' as const }),
      };
    }
    return {
      code: order.code,
      total: order.total,
      ref: dto.orderRef,
      pix: pixForOrder(pix!, order.code, order.total),
    };
  }

  /** Como cobrar um pedido que ja existe (retry): link InfinitePay ou Pix estatico. */
  private prepaidPayment(
    already: {
      code: number;
      total: number;
      prepaid: boolean;
      checkoutUrl?: string;
    },
    pix: PixSettings | undefined,
    online: boolean,
  ): Pick<MenuOrderResult, 'pix' | 'checkoutUrl' | 'onlinePayment'> {
    if (!already.prepaid) return {};
    if (already.checkoutUrl) return { checkoutUrl: already.checkoutUrl };
    if (online) return { onlinePayment: 'INFINITEPAY' };
    return pix ? { pix: pixForOrder(pix, already.code, already.total) } : {};
  }
}
