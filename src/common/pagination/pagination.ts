/**
 * Paginação opt-in dos endpoints de listagem.
 *
 * Quem não manda `page` continua recebendo a lista inteira (PDV, formulário de
 * pedido e seletores dependem disso). Com `page`, o endpoint devolve
 * `{ data, total, page, limit, totalPages }` e só lê aquela fatia do banco.
 */
export interface PageRequest {
  page: number;
  limit: number;
  skip: number;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const DEFAULT_PAGE_LIMIT = 10;
export const MAX_PAGE_LIMIT = 100;

/** Interpreta `?page&limit`; devolve `null` quando a paginação não foi pedida. */
export function parsePageRequest(
  page?: string | number,
  limit?: string | number,
  defaultLimit = DEFAULT_PAGE_LIMIT,
): PageRequest | null {
  if (page === undefined || page === null || page === '') return null;
  const p = Math.max(1, Math.floor(Number(page)) || 1);
  const l = Math.min(
    MAX_PAGE_LIMIT,
    Math.max(1, Math.floor(Number(limit)) || defaultLimit),
  );
  return { page: p, limit: l, skip: (p - 1) * l };
}

export function buildPage<T>(
  data: T[],
  total: number,
  req: PageRequest,
): Paginated<T> {
  return {
    data,
    total,
    page: req.page,
    limit: req.limit,
    totalPages: Math.max(1, Math.ceil(total / req.limit)),
  };
}
