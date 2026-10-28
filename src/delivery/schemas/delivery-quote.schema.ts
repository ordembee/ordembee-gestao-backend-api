import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DeliveryQuoteDocument = DeliveryQuote & Document;

/**
 * Cotacao da Uber guardada do nosso lado: o pedido chega so com o `quoteId`
 * e o frete cobrado e o daqui — nunca um valor enviado pelo navegador.
 * Some sozinha em 1 dia (TTL).
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class DeliveryQuote {
  @Prop({ type: Types.ObjectId, ref: 'Business', required: true })
  businessId: Types.ObjectId;

  @Prop({ required: true })
  quoteId: string;

  /** Reais. */
  @Prop({ required: true, min: 0 })
  fee: number;

  @Prop({ required: true })
  expiresAt: Date;

  /** `dropoffKey` do destino — a cotacao so vale para ele. */
  @Prop({ required: true })
  dropoffKey: string;

  /** Minutos estimados ate a entrega. */
  @Prop()
  etaMinutes?: number;

  /** Cotacao refeita no despacho (para a encomenda `orderId`). */
  @Prop({ type: Types.ObjectId, ref: 'Order' })
  orderId?: Types.ObjectId;

  createdAt?: Date;
}

export const DeliveryQuoteSchema = SchemaFactory.createForClass(DeliveryQuote);

DeliveryQuoteSchema.index({ businessId: 1, quoteId: 1 }, { unique: true });
DeliveryQuoteSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 });
