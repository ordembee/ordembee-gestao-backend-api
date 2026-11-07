import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { IngredientUnit } from './ingredient.schema';

export type IngredientPriceHistoryDocument = IngredientPriceHistory & Document;

/**
 * Uma linha por mudanca de preco de um ingrediente SIMPLES (coleção própria,
 * como pede o escopo por módulo). `previousPricePerUnit` e null no registro
 * inicial (criacao ou baseline gerado na primeira edicao de um ingrediente antigo).
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class IngredientPriceHistory {
  @Prop({ type: Types.ObjectId, ref: 'Business', required: true })
  businessId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Ingredient', required: true })
  ingredientId: Types.ObjectId;

  @Prop({ required: true })
  ingredientName: string;

  @Prop({ type: String, enum: IngredientUnit })
  unit?: IngredientUnit;

  @Prop({ required: true, min: 0 })
  purchasePrice: number;

  @Prop({ required: true, min: 0.0001 })
  quantityPurchased: number;

  @Prop({ required: true, min: 0 })
  pricePerUnit: number;

  @Prop({ type: Number, default: null })
  previousPricePerUnit: number | null;

  /** Momento em que o preco passou a valer (baseline usa a data original). */
  @Prop({ required: true })
  effectiveAt: Date;

  @Prop({ default: false })
  isBaseline: boolean;

  @Prop()
  changedByUid?: string;

  @Prop()
  changedByName?: string;

  @Prop()
  changedByRole?: string;

  createdAt?: Date;
}

export const IngredientPriceHistorySchema = SchemaFactory.createForClass(
  IngredientPriceHistory,
);
IngredientPriceHistorySchema.index({
  businessId: 1,
  ingredientId: 1,
  effectiveAt: 1,
});
