import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ _id: false })
class ComboItem {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true })
  productName: string;
}

export { ComboItem };

export type ProductDocument = Product & Document;

@Schema({ _id: false })
class ChannelPrice {
  @Prop({ min: 0, default: 0 })
  value: number;

  @Prop({ default: false })
  active: boolean;
}

@Schema({ _id: false })
class ProductPrices {
  @Prop({ type: ChannelPrice, default: () => ({ value: 0, active: true }) })
  caixa: ChannelPrice;

  @Prop({ type: ChannelPrice, default: () => ({ value: 0, active: false }) })
  ifood: ChannelPrice;

  @Prop({ type: ChannelPrice, default: () => ({ value: 0, active: false }) })
  food99: ChannelPrice;

  @Prop({ type: ChannelPrice, default: () => ({ value: 0, active: false }) })
  deliveryProprio: ChannelPrice;

  @Prop({ type: ChannelPrice, default: () => ({ value: 0, active: false }) })
  ordemBee: ChannelPrice;
}

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true })
  name: string;

  @Prop()
  description: string;

  @Prop()
  sku: string;

  @Prop({ type: Types.ObjectId, ref: 'Category' })
  categoryId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Business', required: true })
  businessId: Types.ObjectId;

  @Prop({ type: ProductPrices, required: true })
  prices: ProductPrices;

  @Prop()
  imageUrl: string;

  @Prop({ default: 'un' })
  unit: string;

  @Prop({ default: -1 })
  stock: number;

  @Prop({ min: 0, default: 0 })
  costPrice: number;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isCombo: boolean;

  @Prop({
    type: [
      {
        productId: { type: Types.ObjectId, ref: 'Product' },
        quantity: Number,
        productName: String,
      },
    ],
    default: [],
  })
  comboItems: ComboItem[];

  // Precificação que alimenta o costPrice deste produto em tempo real
  // (opcional). Não faz sentido para combos — validado no service.
  @Prop({ type: Types.ObjectId, ref: 'Pricing' })
  pricingId?: Types.ObjectId;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ businessId: 1, isActive: 1 });
ProductSchema.index({ businessId: 1, name: 'text', description: 'text' });
// 1 Precificação = 1 Produto ativo por vez.
ProductSchema.index(
  { businessId: 1, pricingId: 1 },
  {
    unique: true,
    partialFilterExpression: { pricingId: { $exists: true }, isActive: true },
  },
);
