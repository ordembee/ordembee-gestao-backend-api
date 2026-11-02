import { Types } from 'mongoose';
import { OwnDeliveryService } from './own-delivery.service';

const exec = (v: unknown) => ({ exec: () => Promise.resolve(v) });
const businessId = new Types.ObjectId();

const ADDRESS = {
  cep: '20040020',
  street: 'Rua A',
  number: '10',
  district: 'Centro',
  city: 'Rio de Janeiro',
  state: 'RJ',
};

// ~1 grau de latitude = 111 km; 0.0072 grau ~ 0,8 km em linha reta (1 km por ruas).
const ORIGIN = { lat: -22.9, lng: -43.2, source: 'AUTO', precision: 'ADDRESS' };
const TIERS = [
  { maxKm: 1, fee: 6.9 },
  { maxKm: 2, fee: 8.9 },
  { maxKm: 3, fee: 9.9 },
];

function setup(
  opts: {
    menu?: any;
    point?: { lat: number; lng: number; precision: string } | null;
    business?: any;
  } = {},
) {
  const menu =
    opts.menu === undefined
      ? {
          businessId,
          enabled: true,
          store: {
            delivery: {
              deliveryProvider: 'PROPRIA',
              deliveryEnabled: true,
              ownTiers: TIERS,
              origin: ORIGIN,
            },
          },
        }
      : opts.menu;
  const menuModel = {
    findOne: jest.fn(() => ({
      select: () => ({ lean: () => exec(menu) }),
    })),
    updateOne: jest.fn(() => exec({})),
  };
  const businessModel = {
    findById: jest.fn(() => ({
      select: () => ({ lean: () => exec(opts.business ?? null) }),
    })),
  };
  const quoteModel = { create: jest.fn(async (d) => d) };
  const geocoding = {
    geocode: jest.fn(async () =>
      opts.point === undefined
        ? { lat: -22.9 - 0.0072, lng: -43.2, precision: 'ADDRESS', source: 'x' }
        : opts.point,
    ),
  };
  const service = new OwnDeliveryService(
    businessModel as any,
    menuModel as any,
    quoteModel as any,
    geocoding as any,
  );
  return { service, menuModel, quoteModel, geocoding };
}

describe('OwnDeliveryService', () => {
  describe('quoteForMenu', () => {
    it('cota pela faixa da distancia e guarda a cotacao', async () => {
      const { service, quoteModel } = setup();
      const q = await service.quoteForMenu('loja', ADDRESS);
      expect(q.fee).toBe(6.9);
      expect(q.distanceKm).toBeGreaterThan(0.9);
      expect(q.distanceKm).toBeLessThanOrEqual(1);
      expect(quoteModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ businessId, fee: 6.9, quoteId: q.quoteId }),
      );
    });

    it('mais longe, faixa maior', async () => {
      const { service } = setup({
        point: { lat: -22.9 - 0.0144, lng: -43.2, precision: 'ADDRESS' },
      });
      expect((await service.quoteForMenu('loja', ADDRESS)).fee).toBe(8.9);
    });

    it('fora da maior faixa = nao atende', async () => {
      const { service, quoteModel } = setup({
        point: { lat: -23.2, lng: -43.2, precision: 'ADDRESS' },
      });
      await expect(service.quoteForMenu('loja', ADDRESS)).rejects.toMatchObject(
        { response: { reason: 'DELIVERY_UNAVAILABLE' } },
      );
      expect(quoteModel.create).not.toHaveBeenCalled();
    });

    it('endereco nao localizado = pedido invalido', async () => {
      const { service } = setup({ point: null });
      await expect(service.quoteForMenu('loja', ADDRESS)).rejects.toMatchObject(
        { response: { fields: ['address'] } },
      );
    });

    it('sem faixas ou com a Uber, nao cota por distancia', async () => {
      for (const delivery of [
        { deliveryProvider: 'PROPRIA', ownTiers: [], origin: ORIGIN },
        { deliveryProvider: 'UBER', ownTiers: TIERS, origin: ORIGIN },
      ]) {
        const { service } = setup({
          menu: { businessId, enabled: true, store: { delivery } },
        });
        await expect(
          service.quoteForMenu('loja', ADDRESS),
        ).rejects.toMatchObject({ response: { reason: 'DELIVERY_DISABLED' } });
      }
    });

    it('faixas sem ponto de saida = indisponivel', async () => {
      const { service } = setup({
        menu: {
          businessId,
          enabled: true,
          store: { delivery: { deliveryProvider: 'PROPRIA', ownTiers: TIERS } },
        },
      });
      await expect(service.quoteForMenu('loja', ADDRESS)).rejects.toThrow(
        /ainda não configurou/,
      );
    });
  });

  describe('setOrigin', () => {
    it('sem endereco, usa o da loja (AUTO)', async () => {
      const { service, menuModel } = setup({
        business: { address: { ...ADDRESS } },
      });
      const o = await service.setOrigin(businessId.toString());
      expect(o.source).toBe('AUTO');
      expect(menuModel.updateOne).toHaveBeenCalledWith(
        { businessId },
        { $set: { 'store.delivery.origin': o } },
        { upsert: true },
      );
    });

    it('com endereco informado, grava como MANUAL', async () => {
      const { service } = setup();
      const o = await service.setOrigin(businessId.toString(), ADDRESS);
      expect(o.source).toBe('MANUAL');
      expect(o.label).toContain('Rua A, 10');
    });

    it('loja sem endereco cadastrado e sem endereco informado', async () => {
      const { service } = setup({ business: { address: undefined } });
      await expect(service.setOrigin(businessId.toString())).rejects.toThrow(
        /Cadastre o endereço/,
      );
    });

    it('endereco que nao localiza', async () => {
      const { service, menuModel } = setup({ point: null });
      await expect(
        service.setOrigin(businessId.toString(), ADDRESS),
      ).rejects.toThrow(/localizar/);
      expect(menuModel.updateOne).not.toHaveBeenCalled();
    });
  });
});
