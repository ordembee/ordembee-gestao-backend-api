import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Business,
  BusinessDocument,
  BusinessPermissions,
  DEFAULT_PERMISSIONS,
  EffectivePermissions,
} from './schemas/business.schema';
import { Role } from '../common/enums/role.enum';
import { UpdatePermissionsDto } from './dto/update-permissions.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { onlyDigits } from '../common/document/cpf-cnpj';
import {
  DEFAULT_TIMEZONE,
  resolveTimeZone,
} from '../common/date/timezone.util';

const TZ_CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class BusinessService {
  private readonly logger = new Logger(BusinessService.name);
  private readonly tzCache = new Map<string, { tz: string; at: number }>();

  constructor(
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
  ) {}

  /** Fuso IANA do negocio, com cache curto — base de todo calculo de dia/periodo. */
  async getTimezone(businessId: string): Promise<string> {
    const cached = this.tzCache.get(businessId);
    if (cached && Date.now() - cached.at < TZ_CACHE_TTL_MS) return cached.tz;

    const business = await this.businessModel
      .findById(new Types.ObjectId(businessId))
      .select('timezone')
      .lean()
      .exec();

    const tz = resolveTimeZone(business?.timezone) || DEFAULT_TIMEZONE;
    this.tzCache.set(businessId, { tz, at: Date.now() });
    return tz;
  }

  async getSettings(businessId: string) {
    const business = await this.businessModel
      .findById(new Types.ObjectId(businessId))
      .select(
        'name city currency businessType logoUrl timezone document phone email address',
      )
      .lean()
      .exec();

    if (!business) throw new NotFoundException('Negócio não encontrado');

    return {
      name: business.name,
      city: business.city ?? null,
      currency: business.currency ?? 'BRL',
      businessType: business.businessType ?? null,
      logoUrl: business.logoUrl ?? null,
      timezone: resolveTimeZone(business.timezone),
      document: business.document ?? null,
      phone: business.phone ?? null,
      email: business.email ?? null,
      address: business.address ?? null,
    };
  }

  async updateSettings(businessId: string, dto: UpdateBusinessDto) {
    const update: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    if (dto.name !== undefined) update.name = dto.name;
    if (dto.city !== undefined) update.city = dto.city;
    // Texto vazio apaga o campo; CPF/CNPJ fica so com digitos.
    if (dto.document !== undefined) {
      if (dto.document === '') unset.document = '';
      else update.document = onlyDigits(dto.document);
    }
    if (dto.phone !== undefined) {
      if (dto.phone === '') unset.phone = '';
      else update.phone = dto.phone.trim();
    }
    if (dto.email !== undefined) {
      if (dto.email === '') unset.email = '';
      else update.email = dto.email.trim().toLowerCase();
    }
    if (dto.address !== undefined) {
      update.address = {
        cep: dto.address.cep,
        street: dto.address.street.trim(),
        number: dto.address.number.trim(),
        district: dto.address.district.trim(),
        city: dto.address.city.trim(),
        state: dto.address.state.toUpperCase(),
        complement: dto.address.complement?.trim() || undefined,
      };
      // A cidade do cadastro acompanha o endereco.
      if (dto.city === undefined) update.city = dto.address.city.trim();
    }
    if (dto.currency !== undefined) update.currency = dto.currency;
    if (dto.businessType !== undefined) update.businessType = dto.businessType;
    if (dto.timezone !== undefined)
      update.timezone = resolveTimeZone(dto.timezone);

    const business = await this.businessModel
      .findByIdAndUpdate(
        new Types.ObjectId(businessId),
        {
          ...(Object.keys(update).length ? { $set: update } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
        { new: true },
      )
      .select(
        'name city currency businessType logoUrl timezone document phone email address',
      )
      .lean()
      .exec();

    if (!business) throw new NotFoundException('Negócio não encontrado');

    this.tzCache.delete(businessId);
    this.logger.log(
      `Ajustes do negócio atualizados: negócio=${businessId} | campos=${[...Object.keys(update), ...Object.keys(unset)].join(',')}`,
    );

    return {
      name: business.name,
      city: business.city ?? null,
      currency: business.currency ?? 'BRL',
      businessType: business.businessType ?? null,
      logoUrl: business.logoUrl ?? null,
      timezone: resolveTimeZone(business.timezone),
      document: business.document ?? null,
      phone: business.phone ?? null,
      email: business.email ?? null,
      address: business.address ?? null,
    };
  }

  async getPermissions(businessId: string): Promise<BusinessPermissions> {
    const business = await this.businessModel
      .findById(new Types.ObjectId(businessId))
      .exec();

    if (!business) throw new NotFoundException('Negócio não encontrado');

    return business.permissions ?? DEFAULT_PERMISSIONS;
  }

  async updatePermissions(
    businessId: string,
    dto: UpdatePermissionsDto,
  ): Promise<BusinessPermissions> {
    const business = await this.businessModel
      .findById(new Types.ObjectId(businessId))
      .exec();

    if (!business) throw new NotFoundException('Negócio não encontrado');

    const current = business.permissions ?? DEFAULT_PERMISSIONS;

    const merged: BusinessPermissions = {
      gerente: { ...current.gerente, ...(dto.gerente ?? {}) },
      caixa: { ...current.caixa, ...(dto.caixa ?? {}) },
    };

    await this.businessModel
      .findByIdAndUpdate(businessId, { permissions: merged })
      .exec();

    this.logger.log(`Permissões atualizadas: negócio=${businessId}`);
    return merged;
  }

  async getEffectivePermissions(
    businessId: string,
    role: Role,
  ): Promise<EffectivePermissions> {
    const ALL_TRUE = {
      ...DEFAULT_PERMISSIONS.gerente,
      ...DEFAULT_PERMISSIONS.caixa,
    };
    Object.keys(ALL_TRUE).forEach((k) => ((ALL_TRUE as any)[k] = true));

    if (role === Role.OWNER) return ALL_TRUE as EffectivePermissions;

    const permissions = await this.getPermissions(businessId);

    if (role === Role.GERENTE) {
      return {
        ...ALL_TRUE,
        ...permissions.gerente,
        canViewProducts: true,
        canViewCategories: true,
      } as EffectivePermissions;
    }

    return { ...ALL_TRUE, ...permissions.caixa } as EffectivePermissions;
  }
}
