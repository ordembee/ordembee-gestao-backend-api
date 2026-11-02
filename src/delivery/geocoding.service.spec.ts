import { GeocodingService } from './geocoding.service';

const exec = (v: unknown) => ({ exec: () => Promise.resolve(v) });
const ADDRESS = {
  cep: '20040-020',
  street: 'Rua A',
  number: '10',
  district: 'Centro',
  city: 'Rio de Janeiro',
  state: 'RJ',
};

function setup(cached: any = null) {
  const cacheModel = {
    findOne: jest.fn(() => ({ lean: () => exec(cached) })),
    updateOne: jest.fn(() => exec({})),
  };
  return {
    service: new GeocodingService(cacheModel as any),
    cacheModel,
  };
}

const json = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

describe('GeocodingService', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('usa o cache sem consultar ninguem', async () => {
    const { service } = setup({
      lat: -22.9,
      lng: -43.2,
      precision: 'ADDRESS',
      source: 'nominatim',
    });
    expect(await service.geocode(ADDRESS)).toMatchObject({ lat: -22.9 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acha pela rua no Nominatim e guarda no cache', async () => {
    fetchMock.mockResolvedValueOnce(
      json([{ lat: '-22.91', lon: '-43.17', addresstype: 'house' }]),
    );
    const { service, cacheModel } = setup();
    const r = await service.geocode(ADDRESS);
    expect(r).toEqual({
      lat: -22.91,
      lng: -43.17,
      precision: 'ADDRESS',
      source: 'nominatim',
    });
    expect(cacheModel.updateOne).toHaveBeenCalled();
  });

  it('rua sem numero no mapa = precisao STREET', async () => {
    fetchMock.mockResolvedValueOnce(
      json([{ lat: '-22.91', lon: '-43.17', addresstype: 'road' }]),
    );
    const { service } = setup();
    expect((await service.geocode(ADDRESS))?.precision).toBe('STREET');
  });

  it('Nominatim sem resultado: cai para o centro do CEP (BrasilAPI)', async () => {
    fetchMock
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(
        json({
          service: 'correios',
          location: { coordinates: { latitude: '-22.9', longitude: '-43.2' } },
        }),
      );
    const { service } = setup();
    expect(await service.geocode(ADDRESS)).toEqual({
      lat: -22.9,
      lng: -43.2,
      precision: 'CEP',
      source: 'brasilapi',
    });
  });

  it('rua fora do mapa: usa o centro do bairro', async () => {
    fetchMock
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(
        json([{ lat: '-22.85', lon: '-43.38', addresstype: 'suburb' }]),
      );
    const { service } = setup();
    expect(await service.geocode(ADDRESS)).toEqual({
      lat: -22.85,
      lng: -43.38,
      precision: 'CEP',
      source: 'nominatim-district',
    });
  });

  it('ignora o centro da cidade que a BrasilAPI (open-cep) devolve', async () => {
    fetchMock
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(
        json({
          service: 'open-cep',
          location: {
            coordinates: { latitude: '-22.90642', longitude: '-43.18223' },
          },
        }),
      );
    const { service } = setup();
    expect(await service.geocode(ADDRESS)).toBeNull();
  });

  it('cache antigo da BrasilAPI e refeito', async () => {
    fetchMock.mockResolvedValueOnce(
      json([{ lat: '-22.91', lon: '-43.17', addresstype: 'house' }]),
    );
    const { service } = setup({
      lat: -22.9,
      lng: -43.2,
      precision: 'CEP',
      source: 'brasilapi',
    });
    expect((await service.geocode(ADDRESS))?.source).toBe('nominatim');
  });

  it('nada acha o endereco: null e nada no cache', async () => {
    fetchMock
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ location: { coordinates: {} } }));
    const { service, cacheModel } = setup();
    expect(await service.geocode(ADDRESS)).toBeNull();
    expect(cacheModel.updateOne).not.toHaveBeenCalled();
  });

  it('Nominatim fora do ar nao derruba: tenta o CEP', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(
        json({
          location: { coordinates: { latitude: -22.9, longitude: -43.2 } },
        }),
      );
    const { service } = setup();
    expect((await service.geocode(ADDRESS))?.precision).toBe('CEP');
  });
});
