/** Regras puras da InfinitePay (sem rede, sem banco) — testaveis isoladamente. */

/** Mesmas regras do slug (2 a 50, sem espaco nem simbolo nas pontas), mantendo caixa, `.` e `_` que a InfinitePay aceita. */
export const INFINITEPAY_HANDLE =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,48}[A-Za-z0-9]$/;

/** '$minha-loja' / ' Minha-Loja ' -> 'Minha-Loja' (a API quer sem o `$`). */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^\$+/, '').trim();
}

/** Valor mínimo que a InfinitePay aceita num link (testado na API: 99 centavos recusa, 100 aceita). */
export const INFINITEPAY_MIN_CENTS = 100;

export const toCents = (value: number): number => Math.round(value * 100);
export const fromCents = (cents: number): number => Math.round(cents) / 100;

export interface LinkItemSource {
  productName: string;
  quantity: number;
  unitPrice: number;
  options?: { name: string }[];
}

/**
 * Itens do link: um por linha do pedido (preco unitario ja com complementos)
 * e uma linha para a taxa de entrega — a soma tem de bater com o total do
 * pedido, senao o cliente pagaria um valor diferente do cobrado.
 */
export function buildLinkItems(
  items: LinkItemSource[],
  deliveryFee: number,
): { quantity: number; price: number; description: string }[] {
  const lines = items.map((item) => {
    const extras = (item.options ?? []).map((o) => o.name).filter(Boolean);
    return {
      quantity: item.quantity,
      price: toCents(item.unitPrice),
      description: (extras.length
        ? `${item.productName} (${extras.join(', ')})`
        : item.productName
      ).slice(0, 120),
    };
  });
  if (deliveryFee > 0) {
    lines.push({
      quantity: 1,
      price: toCents(deliveryFee),
      description: 'Taxa de entrega',
    });
  }
  return lines;
}

/** "Pedido #57 · 1x Pepsi, 2x Coca" — o que o cliente vê quando o link tem uma linha só. */
export function describeOrderLine(
  label: string,
  items: LinkItemSource[],
): string {
  const list = items.map((i) => `${i.quantity}x ${i.productName}`).join(', ');
  return (list ? `${label} · ${list}` : label).slice(0, 120);
}

export const sumCents = (lines: { quantity: number; price: number }[]) =>
  lines.reduce((sum, l) => sum + l.quantity * l.price, 0);

/** A doc nao descreve a resposta de `POST /links`: aceita as chaves provaveis. */
export function parseLinkUrl(body: unknown): string | null {
  const read = (o: unknown): string | null => {
    if (!o || typeof o !== 'object') return null;
    for (const key of ['url', 'checkout_url', 'link', 'payment_url']) {
      const v = (o as Record<string, unknown>)[key];
      if (typeof v === 'string' && /^https:\/\//i.test(v)) return v;
    }
    return null;
  };
  const top = read(body);
  if (top) return top;
  const data = (body as { data?: unknown } | null)?.data;
  return read(data);
}

export type PaymentMethodOfCapture =
  | 'PIX'
  | 'CARTAO_CREDITO'
  | 'CARTAO_DEBITO'
  | 'PAGAMENTO_ONLINE';

export function methodOfCapture(capture?: string): PaymentMethodOfCapture {
  if (capture === 'pix') return 'PIX';
  if (capture === 'credit_card') return 'CARTAO_CREDITO';
  if (capture === 'debit_card') return 'CARTAO_DEBITO';
  return 'PAGAMENTO_ONLINE';
}

/** Endereco de entrega do pedido no formato do link (CEP so com digitos). */
export function toLinkAddress(a?: {
  cep: string;
  street: string;
  number: string;
  district: string;
  complement?: string;
}) {
  if (!a) return undefined;
  return {
    cep: a.cep.replace(/\D/g, ''),
    street: a.street,
    neighborhood: a.district,
    number: a.number,
    complement: a.complement || undefined,
  };
}

/**
 * Endereco de entrega gravado no pedido do cardapio ("Rua, 58 – apto\nBairro ·
 * CEP 21630-240\nRef.: ...", ver formatAddress) de volta em campos. Serve a
 * entrega propria, que nao tem o `delivery.dropoff` estruturado da Uber.
 * Sem CEP valido devolve undefined (o link sai sem endereco).
 */
export function parseCustomerAddress(text?: string) {
  if (!text) return undefined;
  const [line1 = '', line2 = ''] = text.split('\n').map((l) => l.trim());
  const [streetNumber = '', ...comp] = line1.split(' – ');
  const at = streetNumber.lastIndexOf(',');
  const street = (at >= 0 ? streetNumber.slice(0, at) : streetNumber).trim();
  const number = (at >= 0 ? streetNumber.slice(at + 1) : '').trim();
  const [district = '', cepPart = ''] = line2.split(' · ');
  const cep = cepPart.replace(/\D/g, '');
  if (cep.length !== 8 || !street) return undefined;
  return {
    cep,
    street,
    number,
    district: district.trim(),
    complement: comp.join(' – ').trim() || undefined,
  };
}
