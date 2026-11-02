interface AddressParts {
  street?: string;
  number?: string;
  district?: string;
  city?: string;
  state?: string;
  complement?: string;
}

/**
 * Endereço do negócio em uma linha ("Rua A, 10 - Bairro, Cidade/UF"): é o único
 * endereço da loja — o do cardápio, o da retirada e a saída das entregas.
 */
export function formatBusinessAddress(a?: AddressParts | null): string {
  if (!a?.street || !a.number) return '';
  const head = `${a.street.trim()}, ${a.number.trim()}${a.complement?.trim() ? ` (${a.complement.trim()})` : ''}`;
  const place = [
    a.district?.trim(),
    a.city?.trim()
      ? `${a.city.trim()}${a.state ? `/${a.state.toUpperCase()}` : ''}`
      : '',
  ].filter(Boolean);
  return [head, ...place].join(' - ');
}
