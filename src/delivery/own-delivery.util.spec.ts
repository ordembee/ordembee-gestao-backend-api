import {
  estimatedRoadKm,
  haversineKm,
  pickTier,
  sortTiers,
  tiersError,
  usesDistanceTiers,
} from './own-delivery.util';

const TIERS = [
  { maxKm: 3, fee: 9.9 },
  { maxKm: 1, fee: 6.9 },
  { maxKm: 2, fee: 8.9 },
];

describe('own-delivery.util', () => {
  it('haversine: 1 grau de latitude ~ 111 km', () => {
    const km = haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(km).toBeGreaterThan(111);
    expect(km).toBeLessThan(111.4);
  });

  it('distancia por ruas = linha reta x 1,25', () => {
    const a = { lat: -22.9, lng: -43.2 };
    const b = { lat: -22.91, lng: -43.2 };
    expect(estimatedRoadKm(a, b)).toBeCloseTo(haversineKm(a, b) * 1.25, 1);
  });

  it('ordena as faixas por km', () => {
    expect(sortTiers(TIERS).map((t) => t.maxKm)).toEqual([1, 2, 3]);
  });

  it('escolhe a primeira faixa que alcanca a distancia', () => {
    expect(pickTier(TIERS, 0.4)?.fee).toBe(6.9);
    expect(pickTier(TIERS, 1)?.fee).toBe(6.9);
    expect(pickTier(TIERS, 1.01)?.fee).toBe(8.9);
    expect(pickTier(TIERS, 3)?.fee).toBe(9.9);
  });

  it('fora da maior faixa = nao atende', () => {
    expect(pickTier(TIERS, 3.01)).toBeNull();
    expect(pickTier([], 1)).toBeNull();
  });

  it('valida as faixas', () => {
    expect(tiersError(TIERS)).toBeNull();
    expect(tiersError([{ maxKm: 0, fee: 5 }])).toMatch(/0,1/);
    expect(tiersError([{ maxKm: 2, fee: -1 }])).toMatch(/negativa/);
    expect(
      tiersError([
        { maxKm: 2, fee: 5 },
        { maxKm: 2, fee: 6 },
      ]),
    ).toMatch(/mesmo limite/);
  });

  it('so cobra por distancia na entrega propria com faixas', () => {
    expect(
      usesDistanceTiers({ deliveryProvider: 'PROPRIA', ownTiers: TIERS }),
    ).toBe(true);
    expect(
      usesDistanceTiers({ deliveryProvider: 'PROPRIA', ownTiers: [] }),
    ).toBe(false);
    expect(
      usesDistanceTiers({ deliveryProvider: 'UBER', ownTiers: TIERS }),
    ).toBe(false);
    expect(usesDistanceTiers(undefined)).toBe(false);
  });
});
