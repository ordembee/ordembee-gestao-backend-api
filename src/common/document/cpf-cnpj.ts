/** Valida CPF (11 digitos) ou CNPJ (14) pelos digitos verificadores. Aceita pontuacao. */
export function onlyDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function check(base: string, weights: number[]): number {
  const sum = base
    .split('')
    .reduce((acc, d, i) => acc + Number(d) * weights[i], 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function isValidCpf(raw: string): boolean {
  const d = onlyDigits(raw);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const w1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = check(d.slice(0, 9), w1);
  const d2 = check(d.slice(0, 9) + d1, w2);
  return d.endsWith(`${d1}${d2}`);
}

export function isValidCnpj(raw: string): boolean {
  const d = onlyDigits(raw);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = check(d.slice(0, 12), w1);
  const d2 = check(d.slice(0, 12) + d1, w2);
  return d.endsWith(`${d1}${d2}`);
}

export const isValidCpfOrCnpj = (raw: string): boolean =>
  isValidCpf(raw) || isValidCnpj(raw);
