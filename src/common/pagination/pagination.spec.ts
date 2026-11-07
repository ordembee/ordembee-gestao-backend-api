import { buildPage, parsePageRequest } from './pagination';

describe('pagination', () => {
  it('retorna null quando page não foi enviado (lista completa)', () => {
    expect(parsePageRequest(undefined, '10')).toBeNull();
    expect(parsePageRequest('', '10')).toBeNull();
  });

  it('normaliza page/limit e calcula skip', () => {
    expect(parsePageRequest('3', '10')).toEqual({ page: 3, limit: 10, skip: 20 });
    expect(parsePageRequest('0', 'abc')).toEqual({ page: 1, limit: 10, skip: 0 });
    expect(parsePageRequest('-4', '5')).toEqual({ page: 1, limit: 5, skip: 0 });
  });

  it('limita o tamanho máximo da página', () => {
    expect(parsePageRequest('1', '9999')?.limit).toBe(100);
  });

  it('monta a resposta com totalPages >= 1', () => {
    const req = parsePageRequest('2', '10')!;
    expect(buildPage([1], 25, req)).toEqual({
      data: [1],
      total: 25,
      page: 2,
      limit: 10,
      totalPages: 3,
    });
    expect(buildPage([], 0, req).totalPages).toBe(1);
  });
});
