import type { MenuOpeningHours } from '../business/schemas/business.schema';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const toMinutes = (hhmm: string): number => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Formato aceito: chaves '0'..'6' (0 = domingo) com ['HH:mm','HH:mm'] ou null. */
export function isValidOpeningHours(value: unknown): value is MenuOpeningHours {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([day, range]) => {
    if (!/^[0-6]$/.test(day)) return false;
    if (range === null) return true;
    return (
      Array.isArray(range) &&
      range.length === 2 &&
      range.every((t) => typeof t === 'string' && HHMM.test(t)) &&
      range[0] !== range[1]
    );
  });
}

/** Dia da semana (0 = domingo) e minutos do dia de `now`, vistos no fuso `tz`. */
function zonedWeekdayMinutes(
  now: Date,
  tz: string,
): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: WEEKDAYS.indexOf(get('weekday')),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/**
 * A loja esta aberta em `now`? Considera o turno de ontem que passa da
 * meia-noite (ex.: sexta 18:00–02:00 cobre sabado 01:30). Mesma regra do
 * cardapio (`storeStatus` em cardapio-digital/index.html).
 */
export function isOpenAt(
  hours: MenuOpeningHours | undefined,
  tz: string,
  now = new Date(),
): boolean {
  if (!hours) return false;
  const { day, minutes } = zonedWeekdayMinutes(now, tz);

  const yesterday = hours[String((day + 6) % 7)];
  if (yesterday) {
    const [start, end] = yesterday.map(toMinutes);
    if (end < start && minutes < end) return true;
  }

  const today = hours[String(day)];
  if (!today) return false;
  const [start, end] = today.map(toMinutes);
  return minutes >= start && (end < start || minutes < end);
}
