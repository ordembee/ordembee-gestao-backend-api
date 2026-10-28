import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CustomerDocument = Customer & Document;

/** Endereco estruturado — o ultimo informado num pedido com entrega. */
@Schema({ _id: false })
export class CustomerAddress {
  @Prop()
  cep?: string;

  @Prop({ required: true })
  street: string;

  @Prop({ required: true })
  number: string;

  @Prop({ required: true })
  district: string;

  @Prop()
  city?: string;

  @Prop()
  state?: string;

  @Prop()
  complement?: string;

  @Prop()
  reference?: string;
}

@Schema({ timestamps: true })
export class Customer {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  phone: string;

  @Prop()
  document: string;

  /** Endereco de entrega — usado no card do cliente e nas encomendas.
   * Atualizado a cada pedido com entrega (vale o mais recente). */
  @Prop()
  address: string;

  /** Mesmo endereco, campo a campo, quando veio estruturado (cardapio).
   * Removido quando a loja edita o `address` em texto livre. */
  @Prop({ type: SchemaFactory.createForClass(CustomerAddress) })
  addressDetails?: CustomerAddress;

  @Prop()
  notes: string;

  @Prop({ type: Types.ObjectId, ref: 'Business', required: true })
  businessId: Types.ObjectId;

  @Prop({ default: true })
  isActive: boolean;
}

export const CustomerSchema = SchemaFactory.createForClass(Customer);

CustomerSchema.index({ businessId: 1, name: 1 });
CustomerSchema.index({ businessId: 1, phone: 1 });
