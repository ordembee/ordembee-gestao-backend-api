import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type BusinessDocument = Business & Document;

export interface GerentePermissions {
  canViewSales: boolean;
  canCancelSales: boolean;
  canApplyDiscounts: boolean;
  canEditProducts: boolean;
  canChangePrices: boolean;
  canManageStock: boolean;
  canViewFinancialReports: boolean;
  canManageUsers: boolean;
}

export interface CaixaPermissions {
  canViewProducts: boolean;
  canViewCategories: boolean;
  canApplyDiscounts: boolean;
  canCancelSales: boolean;
  canRefund: boolean;
  canSellWithNegativeStock: boolean;
  canViewStock: boolean;
}

export interface BusinessPermissions {
  gerente: GerentePermissions;
  caixa: CaixaPermissions;
}

export type EffectivePermissions = GerentePermissions & CaixaPermissions;

export const DEFAULT_PERMISSIONS: BusinessPermissions = {
  gerente: {
    canViewSales: true,
    canCancelSales: false,
    canApplyDiscounts: true,
    canEditProducts: true,
    canChangePrices: false,
    canManageStock: true,
    canViewFinancialReports: false,
    canManageUsers: false,
  },
  caixa: {
    canViewProducts: true,
    canViewCategories: true,
    canApplyDiscounts: false,
    canCancelSales: false,
    canRefund: false,
    canSellWithNegativeStock: false,
    canViewStock: false,
  },
};

/** Recebedor do Pix "copia e cola" estatico da loja (ex.: entrega Uber paga antes no cardapio). */
@Schema({ _id: false })
export class PixSettings {
  @Prop({ required: true })
  key: string;

  @Prop({ required: true })
  merchantName: string;

  @Prop({ required: true })
  merchantCity: string;
}

/**
 * Checkout da InfinitePay: o cliente paga (Pix ou cartao) num link da loja e a
 * confirmacao volta por webhook. Nao ha segredo — so a InfiniteTag (`handle`).
 */
@Schema({ _id: false })
export class InfinitePaySettings {
  /** InfiniteTag da loja, sem o `$`. */
  @Prop({ required: true })
  handle: string;

  @Prop({ default: false })
  enabled: boolean;
}

/** Endereco de coleta da Uber (estruturado — o endereco do cardapio e texto livre). */
@Schema({ _id: false })
export class UberPickupAddress {
  @Prop({ required: true })
  cep: string;

  @Prop({ required: true })
  street: string;

  @Prop({ required: true })
  number: string;

  @Prop({ required: true })
  district: string;

  @Prop({ required: true })
  city: string;

  @Prop({ required: true })
  state: string;

  @Prop()
  complement?: string;
}

/**
 * Conta Uber Direct da loja. `clientSecret` e `webhookSigningKey` ficam
 * CIFRADOS (common/crypto/secret-box) — nunca saem da API em texto.
 */
@Schema({ _id: false })
export class UberDirectSettings {
  @Prop()
  customerId?: string;

  @Prop()
  clientId?: string;

  @Prop()
  clientSecretEnc?: string;

  /** Ultimos 4 caracteres, so para a tela mostrar que existe. */
  @Prop()
  clientSecretHint?: string;

  @Prop()
  webhookSigningKeyEnc?: string;

  @Prop()
  webhookSigningKeyHint?: string;

  /** Conta de testes: a entrega usa o "robo courier" da Uber. */
  @Prop({ default: false })
  sandbox: boolean;

  @Prop({ type: SchemaFactory.createForClass(UberPickupAddress) })
  pickupAddress?: UberPickupAddress;

  /** Telefone de quem entrega o pacote ao entregador (E.164). */
  @Prop()
  pickupPhone?: string;

  /** Instrucoes ao entregador na coleta ("balcao dos fundos"). */
  @Prop()
  pickupNotes?: string;
}

/**
 * Integracoes e configuracoes da loja com parceiros (Uber, Pix, ...). Cada
 * parceiro novo ganha a sua chave aqui — nunca solta na raiz do Business.
 */
@Schema({ _id: false })
export class BusinessConfig {
  @Prop({ type: SchemaFactory.createForClass(UberDirectSettings) })
  uber?: UberDirectSettings;

  @Prop({ type: SchemaFactory.createForClass(PixSettings) })
  pix?: PixSettings;

  @Prop({ type: SchemaFactory.createForClass(InfinitePaySettings) })
  infinitepay?: InfinitePaySettings;
}

/** Endereco da loja (dados cadastrais; o de coleta da Uber e o do cardapio ficam nas suas telas). */
@Schema({ _id: false })
export class BusinessAddress {
  @Prop({ required: true })
  cep: string;

  @Prop({ required: true })
  street: string;

  @Prop({ required: true })
  number: string;

  @Prop({ required: true })
  district: string;

  @Prop({ required: true })
  city: string;

  @Prop({ required: true })
  state: string;

  @Prop()
  complement?: string;
}

@Schema({ timestamps: true })
export class Business {
  @Prop({ required: true })
  name: string;

  @Prop()
  logoUrl: string;

  @Prop()
  businessType: string;

  /** CPF ou CNPJ, so digitos. */
  @Prop()
  document?: string;

  /** Telefone/WhatsApp da loja (como digitado, com mascara). */
  @Prop()
  phone?: string;

  @Prop()
  email?: string;

  @Prop({ type: SchemaFactory.createForClass(BusinessAddress) })
  address?: BusinessAddress;

  @Prop()
  city: string;

  @Prop({ default: 'BRL' })
  currency: string;

  /** Fuso IANA do negocio — base de TODO calculo de dia/periodo (ver common/date/timezone.util). */
  @Prop({ default: 'America/Sao_Paulo' })
  timezone: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ type: Object, default: () => DEFAULT_PERMISSIONS })
  permissions: BusinessPermissions;

  @Prop({ type: SchemaFactory.createForClass(BusinessConfig) })
  config?: BusinessConfig;
}

export const BusinessSchema = SchemaFactory.createForClass(Business);
