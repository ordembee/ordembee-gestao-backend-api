import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ExpenseDocument = Expense & Document;

export enum ExpenseCategory {
  ALUGUEL = 'ALUGUEL',
  ENERGIA = 'ENERGIA',
  AGUA = 'AGUA',
  FUNCIONARIOS = 'FUNCIONARIOS',
  INTERNET = 'INTERNET',
  IMPOSTOS = 'IMPOSTOS',
  INSUMOS = 'INSUMOS',
  MARKETING = 'MARKETING',
  OUTROS = 'OUTROS',
}

export enum ExpenseType {
  FIXO = 'FIXO',
  VARIAVEL = 'VARIAVEL',
}

@Schema({ timestamps: true })
export class Expense {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, min: 0 })
  amount: number;

  @Prop({
    type: String,
    enum: ExpenseCategory,
    default: ExpenseCategory.OUTROS,
  })
  category: ExpenseCategory;

  @Prop({ type: String, enum: ExpenseType, default: ExpenseType.FIXO })
  type: ExpenseType;

  @Prop({ required: true })
  date: Date;

  @Prop({ type: Types.ObjectId, ref: 'Business', required: true })
  businessId: Types.ObjectId;

  @Prop()
  notes: string;

  @Prop({ default: false })
  isOperational: boolean;
}

export const ExpenseSchema = SchemaFactory.createForClass(Expense);

ExpenseSchema.index({ businessId: 1, date: -1 });
ExpenseSchema.index({ businessId: 1, category: 1 });
