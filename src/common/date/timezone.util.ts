/**
 * Utilitario unico de fuso horario do backend.
 *
 * Regra do projeto:
 *  - Instantes reais (Sale.createdAt, StockMovement.createdAt) sao gravados em UTC.
 *  - Datas puras (Expense.date) sao gravadas como meia-noite UTC de um dia de calendario.
 *  - Todo calculo de "dia/mes/periodo" e todo agrupamento por dia usa o fuso DO NEGOCIO
 *    (Business.timezone), nunca o fuso do servidor nem o do navegador.
 *
 * O frontend tem um espelho deste arquivo em `frontend/src/utils/datetime.ts` —
 * mantenha os dois em sincronia.
 */

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

/** Valida um identificador IANA ('America/Sao_Paulo', 'Europe/Lisbon', ...). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Normaliza para um fuso valido, caindo no default quando invalido/ausente. */
export function resolveTimeZone(tz: unknown): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

/**
 * Deslocamento (ms) de `tz` em relacao ao UTC no instante `date`.
 * Ex.: America/Sao_Paulo -> -10800000 (-3h).
 */
/** Valor numerico de um campo do formatToParts, com fallback seguro. */
function partVal(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  return Number(parts.find((p) => p.type === type)?.value ?? '0');
}

/** Divide 'YYYY-MM-DD' em [ano, mes, dia] numericos. */
function ymdParts(ymd: string): [number, number, number] {
  const [y = 0, m = 1, d = 1] = ymd.split('-').map(Number);
  return [y, m, d];
}

function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const asUTC = Date.UTC(
    partVal(parts, 'year'),
    partVal(parts, 'month') - 1,
    partVal(parts, 'day'),
    partVal(parts, 'hour'),
    partVal(parts, 'minute'),
    partVal(parts, 'second'),
  );
  return asUTC - date.getTime();
}

/** Data de calendario 'YYYY-MM-DD' de um instante, vista em `tz`. */
export function zonedDateString(instant: Date, tz: string): string {
  // 'en-CA' formata como ISO (YYYY-MM-DD).
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Instante UTC correspondente a meia-noite (00:00:00.000) do dia `ymd` em `tz`. */
export function zonedStartOfDay(ymd: string, tz: string): Date {
  const [y, m, d] = ymdParts(ymd);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  // Uma correcao basta para offsets de hora/meia-hora; a segunda cobre a
  // rara virada de DST perto da meia-noite. Brasil nao tem DST desde 2019.
  let ms = guess - tzOffsetMs(new Date(guess), tz);
  ms = guess - tzOffsetMs(new Date(ms), tz);
  return new Date(ms);
}

/** Instante UTC correspondente a 23:59:59.999 do dia `ymd` em `tz`. */
export function zonedEndOfDay(ymd: string, tz: string): Date {
  return new Date(zonedStartOfDay(ymd, tz).getTime() + 86_400_000 - 1);
}

/**
 * Intervalo [start, end] em instantes UTC cobrindo os dias de calendario
 * `fromYmd`..`toYmd` (inclusive), interpretados em `tz`.
 */
export function zonedRange(
  fromYmd: string,
  toYmd: string,
  tz: string,
): { start: Date; end: Date } {
  return { start: zonedStartOfDay(fromYmd, tz), end: zonedEndOfDay(toYmd, tz) };
}

/**
 * Converte um par de limites vindos do cliente (ISO instante OU 'YYYY-MM-DD')
 * no intervalo de dias-de-calendario correspondente em `tz`.
 * Robusto a instantes levemente deslocados (ex.: 03:00Z de um cliente BRT).
 */
export function rangeFromClientBounds(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  tz: string,
): { start?: Date; end?: Date } {
  const out: { start?: Date; end?: Date } = {};
  if (dateFrom) out.start = zonedStartOfDay(toYmd(dateFrom, tz), tz);
  if (dateTo) out.end = zonedEndOfDay(toYmd(dateTo, tz), tz);
  return out;
}

/**
 * Filtro Mongo {$gte,$lte} para um campo de INSTANTE real (ex.: Sale.createdAt),
 * a partir dos limites do cliente, com os dias resolvidos em `tz`. Snap para o
 * inicio/fim de dia no fuso do negocio — robusto a instante deslocado ou 'YYYY-MM-DD'.
 */
export function instantRangeFilter(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  tz: string,
): { $gte?: Date; $lte?: Date } | null {
  if (!dateFrom && !dateTo) return null;
  const filter: { $gte?: Date; $lte?: Date } = {};
  if (dateFrom) filter.$gte = zonedStartOfDay(toYmd(dateFrom, tz), tz);
  if (dateTo) filter.$lte = zonedEndOfDay(toYmd(dateTo, tz), tz);
  return filter;
}

/** Intervalo [start, end] do dia corrente (em `tz`) — para "resumo do dia". */
export function zonedTodayRange(
  tz: string,
  now: Date = new Date(),
): { start: Date; end: Date } {
  const ymd = zonedDateString(now, tz);
  return { start: zonedStartOfDay(ymd, tz), end: zonedEndOfDay(ymd, tz) };
}

/** 'YYYY-MM-DD' a partir de um ISO instante ou de uma string ja no formato de data. */
export function toYmd(value: string, tz: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return zonedDateString(new Date(value), tz);
}

/* --------------------------------------------------------------------------
 * Campos de DATA PURA (Expense.date): gravados como MEIA-NOITE UTC de um dia
 * de calendario. O filtro compara contra meia-noite UTC dos dias — o fuso do
 * negocio serve apenas para descobrir A QUAL dia um limite do cliente se refere.
 * ----------------------------------------------------------------------- */

/** Meia-noite UTC do dia `ymd`. */
export function utcDayStart(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** 23:59:59.999 UTC do dia `ymd`. */
export function utcDayEnd(ymd: string): Date {
  return new Date(`${ymd}T23:59:59.999Z`);
}

/**
 * Filtro Mongo {$gte,$lte} para um campo de data pura, a partir dos limites
 * do cliente (ISO instante OU 'YYYY-MM-DD'), com o dia resolvido em `tz`.
 */
export function pureDateFilter(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  tz: string,
): { $gte?: Date; $lte?: Date } | null {
  if (!dateFrom && !dateTo) return null;
  const filter: { $gte?: Date; $lte?: Date } = {};
  if (dateFrom) filter.$gte = utcDayStart(toYmd(dateFrom, tz));
  if (dateTo) filter.$lte = utcDayEnd(toYmd(dateTo, tz));
  return filter;
}

/** Mes corrente (em `tz`) como filtro de campo de data pura. */
export function pureDateCurrentMonthFilter(
  tz: string,
  now: Date = new Date(),
): { $gte: Date; $lte: Date } {
  const [y, m] = ymdParts(zonedDateString(now, tz));
  const mm = String(m).padStart(2, '0');
  const lastDate = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    $gte: utcDayStart(`${y}-${mm}-01`),
    $lte: utcDayEnd(`${y}-${mm}-${String(lastDate).padStart(2, '0')}`),
  };
}

/** Primeiro e ultimo instante do mes corrente em `tz`. */
export function zonedCurrentMonthRange(
  tz: string,
  now: Date = new Date(),
): { start: Date; end: Date } {
  const [y, m] = ymdParts(zonedDateString(now, tz)); // no fuso do negocio
  const firstDay = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDate = new Date(Date.UTC(y, m, 0)).getUTCDate(); // dia 0 do mes seguinte
  const lastDay = `${y}-${String(m).padStart(2, '0')}-${String(lastDate).padStart(2, '0')}`;
  return {
    start: zonedStartOfDay(firstDay, tz),
    end: zonedEndOfDay(lastDay, tz),
  };
}
