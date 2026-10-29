import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Business,
  BusinessDocument,
  PixSettings,
  UberDirectSettings,
} from '../business/schemas/business.schema';
import {
  DeliveryProvider,
  MenuOnline,
  MenuOnlineDocument,
} from '../menu/schemas/menu-online.schema';
import {
  SecretBoxError,
  decryptSecret,
  encryptSecret,
} from '../common/crypto/secret-box';
import {
  isValidPixKey,
  normalizePixKey,
  pixText,
} from '../common/pix/pix-brcode';
import { UpdateDeliverySettingsDto } from './dto/delivery.dto';
import {
  UberApiError,
  UberCredentials,
  UberDirectClient,
} from './uber-direct.client';
import { toE164BR } from './uber-direct.util';
import { infinitePayActive } from '../payments/infinitepay.service';

const hint = (plain: string) => plain.slice(-4);

/** O que falta para a loja poder ligar a Uber (vazio = pronto). */
export function uberMissing(
  uber: UberDirectSettings | undefined,
  /** InfiniteTag cadastrada: a Uber cobra antes pela InfinitePay (Pix estatico nao serve). */
  hasInfinitePayHandle: boolean,
): string[] {
  const missing: string[] = [];
  if (!uber?.customerId) missing.push('Customer ID');
  if (!uber?.clientId) missing.push('Client ID');
  if (!uber?.clientSecretEnc) missing.push('Client secret');
  if (!uber?.pickupAddress) missing.push('endereço de coleta');
  if (!uber?.pickupPhone) missing.push('telefone de coleta');
  if (!hasInfinitePayHandle) missing.push('InfiniteTag');
  return missing;
}

/**
 * Modo de entrega do cardapio, recebedor do Pix e conta Uber Direct da loja.
 * So o dono mexe (controller). Segredos entram cifrados e saem mascarados.
 */
@Injectable()
export class DeliverySettingsService {
  private readonly logger = new Logger(DeliverySettingsService.name);

  constructor(
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
    @InjectModel(MenuOnline.name)
    private readonly menuModel: Model<MenuOnlineDocument>,
    private readonly uber: UberDirectClient,
  ) {}

  /** Integracoes (Business.config) + o provedor escolhido no cardapio (MenuOnline). */
  private async load(businessId: string) {
    const id = new Types.ObjectId(businessId);
    const [business, menu] = await Promise.all([
      this.businessModel.findById(id).select('name config').lean().exec(),
      this.menuModel
        .findOne({ businessId: id })
        .select('store.delivery.deliveryProvider')
        .lean<Pick<MenuOnline, 'store'>>()
        .exec(),
    ]);
    if (!business) throw new NotFoundException('Negócio não encontrado');
    return {
      business,
      config: business.config,
      deliveryProvider:
        menu?.store?.delivery?.deliveryProvider ?? DeliveryProvider.PROPRIA,
    };
  }

  async get(businessId: string) {
    const { config, deliveryProvider } = await this.load(businessId);
    const uber = config?.uber;
    return {
      deliveryProvider,
      pix: config?.pix ?? null,
      /** Com a InfinitePay ativa, o Pix local fica guardado mas nao e usado. */
      infinitePayActive: infinitePayActive(config?.infinitepay),
      uberDirect: {
        customerId: uber?.customerId ?? '',
        clientId: uber?.clientId ?? '',
        hasClientSecret: !!uber?.clientSecretEnc,
        clientSecretHint: uber?.clientSecretHint ?? '',
        hasWebhookSigningKey: !!uber?.webhookSigningKeyEnc,
        webhookSigningKeyHint: uber?.webhookSigningKeyHint ?? '',
        sandbox: uber?.sandbox ?? false,
        pickupAddress: uber?.pickupAddress ?? null,
        pickupPhone: uber?.pickupPhone ?? '',
        pickupNotes: uber?.pickupNotes ?? '',
      },
      missing: uberMissing(uber, !!config?.infinitepay?.handle),
      /** Endereco que a loja cadastra no painel da Uber (Webhooks). */
      webhookUrl: process.env.UBER_WEBHOOK_PUBLIC_URL || null,
    };
  }

  async update(businessId: string, dto: UpdateDeliverySettingsDto) {
    const {
      business,
      config: current,
      deliveryProvider,
    } = await this.load(businessId);
    /** Business.config (integracoes) e MenuOnline (provedor) gravam separados. */
    const set: Record<string, unknown> = {};

    if (dto.pix) {
      if (!isValidPixKey(dto.pix.key)) {
        throw new BadRequestException(
          'Chave Pix inválida (CPF, CNPJ, e-mail, +55 telefone ou chave aleatória)',
        );
      }
      set['config.pix'] = {
        key: normalizePixKey(dto.pix.key),
        merchantName: pixText(dto.pix.merchantName, 25),
        merchantCity: pixText(dto.pix.merchantCity, 15),
      };
    }

    let nextUber: UberDirectSettings | undefined = current?.uber;
    if (dto.uberDirect) {
      const u = dto.uberDirect;
      const merged: UberDirectSettings = {
        ...(current?.uber ?? { sandbox: false }),
      };
      try {
        if (u.customerId !== undefined)
          merged.customerId = u.customerId.trim() || undefined;
        if (u.clientId !== undefined)
          merged.clientId = u.clientId.trim() || undefined;
        if (u.clientSecret?.trim()) {
          merged.clientSecretEnc = encryptSecret(u.clientSecret.trim());
          merged.clientSecretHint = hint(u.clientSecret.trim());
        }
        if (u.webhookSigningKey?.trim()) {
          merged.webhookSigningKeyEnc = encryptSecret(
            u.webhookSigningKey.trim(),
          );
          merged.webhookSigningKeyHint = hint(u.webhookSigningKey.trim());
        }
      } catch (error) {
        if (error instanceof SecretBoxError) {
          this.logger.error(`Cifra indisponível: ${error.message}`);
          throw new ServiceUnavailableException(
            'O servidor não está configurado para guardar credenciais (CREDENTIALS_ENCRYPTION_KEY)',
          );
        }
        throw error;
      }
      if (u.sandbox !== undefined) merged.sandbox = u.sandbox;
      if (u.pickupAddress) {
        merged.pickupAddress = {
          ...u.pickupAddress,
          state: u.pickupAddress.state.toUpperCase(),
          complement: u.pickupAddress.complement?.trim() || undefined,
        };
      }
      if (u.pickupPhone !== undefined) {
        if (u.pickupPhone && !toE164BR(u.pickupPhone)) {
          throw new BadRequestException('Telefone de coleta inválido');
        }
        merged.pickupPhone = u.pickupPhone
          ? toE164BR(u.pickupPhone)!
          : undefined;
      }
      if (u.pickupNotes !== undefined)
        merged.pickupNotes = u.pickupNotes.trim() || undefined;
      set['config.uber'] = merged;
      nextUber = merged;
    }

    const provider = dto.deliveryProvider ?? deliveryProvider;
    if (
      provider === DeliveryProvider.UBER &&
      !infinitePayActive(current?.infinitepay)
    ) {
      throw new BadRequestException(
        'Ative o pagamento online (InfinitePay) antes de entregar pela Uber',
      );
    }
    if (provider === DeliveryProvider.UBER) {
      const missing = uberMissing(nextUber, !!current?.infinitepay?.handle);
      if (missing.length) {
        throw new BadRequestException(
          `Para entregar pela Uber, preencha: ${missing.join(', ')}`,
        );
      }
    }

    if (Object.keys(set).length) {
      await this.businessModel
        .updateOne({ _id: business._id }, { $set: set })
        .exec();
    }
    if (dto.deliveryProvider) {
      await this.menuModel
        .updateOne(
          { businessId: business._id },
          {
            $set: { 'store.delivery.deliveryProvider': dto.deliveryProvider },
          },
          { upsert: true },
        )
        .exec();
    }
    if (nextUber?.clientId) this.uber.forget(nextUber.clientId);
    // Nunca logar valores — so quais blocos mudaram.
    this.logger.log(
      `Entrega configurada: negócio=${businessId} | ${[...Object.keys(set), ...(dto.deliveryProvider ? ['deliveryProvider'] : [])].join(',')}`,
    );
    return this.get(businessId);
  }

  /** Testa as credenciais pedindo um token a Uber. */
  async test(businessId: string): Promise<{ ok: true }> {
    const { config } = await this.load(businessId);
    const creds = this.credentialsOf(config?.uber);
    try {
      this.uber.forget(creds.clientId);
      await this.uber.token(creds);
    } catch (error) {
      if (error instanceof UberApiError && error.status === 401) {
        throw new BadRequestException(
          'A Uber recusou o Client ID / Client secret. Confira no painel da Uber Direct.',
        );
      }
      throw new ServiceUnavailableException(
        'Não foi possível falar com a Uber agora. Tente novamente.',
      );
    }
    return { ok: true };
  }

  /** Credenciais decifradas para chamar a Uber (nunca devolvidas ao cliente). */
  credentialsOf(uber: UberDirectSettings | undefined): UberCredentials {
    if (!uber?.customerId || !uber.clientId || !uber.clientSecretEnc) {
      throw new BadRequestException(
        'Uber Direct não configurada. Preencha as credenciais na aba Loja do cardápio.',
      );
    }
    try {
      return {
        customerId: uber.customerId,
        clientId: uber.clientId,
        clientSecret: decryptSecret(uber.clientSecretEnc),
      };
    } catch (error) {
      this.logger.error(
        `Não deu para decifrar o client secret da Uber: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Credencial da Uber ilegível. Cadastre o Client secret de novo.',
      );
    }
  }

  signingKeyOf(uber: UberDirectSettings | undefined): string | null {
    if (!uber?.webhookSigningKeyEnc) return null;
    try {
      return decryptSecret(uber.webhookSigningKeyEnc);
    } catch {
      return null;
    }
  }
}
