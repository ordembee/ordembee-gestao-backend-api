import { parseTimeOfDay } from './reports.service';

describe('parseTimeOfDay', () => {
  it('converte HH:mm em minutos', () => {
    expect(parseTimeOfDay('00:00', 5)).toBe(0);
    expect(parseTimeOfDay('14:30', 0)).toBe(870);
    expect(parseTimeOfDay('9:05', 0)).toBe(545);
  });

  it('usa o fallback quando ausente ou inválido', () => {
    expect(parseTimeOfDay(undefined, 7)).toBe(7);
    expect(parseTimeOfDay('', 7)).toBe(7);
    expect(parseTimeOfDay('24:00', 7)).toBe(7);
    expect(parseTimeOfDay('10:75', 7)).toBe(7);
    expect(parseTimeOfDay('abc', 7)).toBe(7);
  });
});
