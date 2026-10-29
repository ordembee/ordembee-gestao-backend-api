import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** `PUT /menu/infinitepay-settings` — so o dono. */
export class UpdateInfinitePaySettingsDto {
  /** InfiniteTag, com ou sem o `$`. */
  @IsOptional()
  @IsString()
  @MaxLength(51)
  handle?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** Corpo do webhook (a InfinitePay manda mais campos; so estes importam). */
export class InfinitePayWebhookPayload {
  @IsOptional()
  @IsString()
  invoice_slug?: string;

  @IsOptional()
  @IsString()
  transaction_nsu?: string;

  @IsString()
  @MaxLength(80)
  order_nsu: string;

  @IsOptional()
  @IsString()
  receipt_url?: string;
}

/** Corpo comum das rotas internas por pedido. */
export class InternalPaymentDto {
  @IsString()
  @MaxLength(60)
  slug: string;

  /** Parametros que a InfinitePay acrescenta ao voltar do checkout. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  transactionNsu?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  invoiceSlug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  receiptUrl?: string;

  /** Pagina do cardapio para onde o cliente volta depois de pagar. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  redirectUrl?: string;
}
