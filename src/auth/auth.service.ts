import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as admin from 'firebase-admin';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  Business,
  BusinessDocument,
} from '../business/schemas/business.schema';
import {
  Category,
  CategoryDocument,
} from '../categories/schemas/category.schema';
import { RegisterBusinessDto } from './dto/register-business.dto';
import { Role } from '../common/enums/role.enum';
import { resolveTimeZone } from '../common/date/timezone.util';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Business.name)
    private readonly businessModel: Model<BusinessDocument>,
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
  ) {}

  async getOrCreateUser(
    firebaseUid: string,
    email: string,
    displayName: string,
    photoURL: string,
    emailVerified: boolean,
  ) {
    const normalizedEmail = email.toLowerCase();

    let user = await this.userModel
      .findOne({ firebaseUid })
      .populate('businessId')
      .exec();

    if (!user) {
      // Check for a pending invite with this email
      const invite = await this.userModel
        .findOne({ email: normalizedEmail, isPending: true })
        .exec();

      if (invite) {
        user = await this.userModel
          .findByIdAndUpdate(
            invite._id,
            {
              firebaseUid,
              displayName,
              photoURL,
              isActive: true,
              isPending: false,
            },
            { new: true },
          )
          .populate('businessId')
          .exec();

        const businessId = String(invite.businessId);
        await this.setCustomClaims(firebaseUid, user!.role, businessId);

        this.logger.log(
          `Convite aceito: firebaseUid=${firebaseUid} | email=${email} | role=${user!.role}`,
        );
        return user;
      }

      // Same email may already have an active account under a different
      // Firebase identity (e.g. signed up with password, later signed in
      // with Google without linking providers). Adopt that account instead
      // of creating a duplicate — only when Firebase verified the incoming
      // email, so an unverified signup can't hijack someone else's account.
      const existingByEmail = emailVerified
        ? await this.userModel
            .findOne({ email: normalizedEmail, isPending: false })
            .populate('businessId')
            .exec()
        : null;

      if (existingByEmail) {
        user = await this.userModel
          .findByIdAndUpdate(
            existingByEmail._id,
            { firebaseUid },
            { new: true },
          )
          .populate('businessId')
          .exec();
        this.logger.log(
          `Conta adotada por novo provedor: firebaseUid=${firebaseUid} | email=${normalizedEmail} | userId=${existingByEmail._id.toString()}`,
        );
      } else {
        try {
          user = await this.userModel.create({
            firebaseUid,
            email: normalizedEmail,
            displayName,
            photoURL,
            role: Role.OWNER,
          });
          this.logger.log(
            `Novo usuário criado: firebaseUid=${firebaseUid} | email=${normalizedEmail}`,
          );
        } catch (err) {
          // Concurrent requests for the same brand-new firebaseUid can both
          // reach here before either commits; the unique index rejects the
          // loser. Treat it as a benign race and load what the winner wrote.
          if ((err as { code?: number }).code === 11000) {
            user = await this.userModel
              .findOne({ firebaseUid })
              .populate('businessId')
              .exec();
          } else {
            throw err;
          }
        }
      }
    }

    if (user && displayName && user.displayName !== displayName) {
      // The client may send the freshly-typed name before the Firebase ID
      // token claim catches up (createUserWithEmailAndPassword's
      // onAuthStateChanged can race ahead of updateProfile), so the very
      // first login might have created this user with no name yet. Heal it
      // here instead of trusting only the create-time value.
      user = await this.userModel
        .findByIdAndUpdate(user._id, { displayName }, { new: true })
        .populate('businessId')
        .exec();
    }

    if (user?.businessId) {
      // Re-apply custom claims on every login for users that already have a business.
      // This auto-heals tokens whose claims are stale or missing (e.g. after manual DB edits).
      // businessId may be a populated Business document — extract _id explicitly.
      const businessId = user.populated('businessId')
        ? String((user.businessId as unknown as BusinessDocument)._id)
        : String(user.businessId);
      await this.setCustomClaims(firebaseUid, user.role, businessId);
    }

    return user;
  }

  async registerBusiness(firebaseUid: string, dto: RegisterBusinessDto) {
    const user = await this.userModel.findOne({ firebaseUid }).exec();

    if (!user) {
      this.logger.warn(
        `Registro de negócio sem usuário válido: firebaseUid=${firebaseUid}`,
      );
      throw new ConflictException('Usuário não encontrado');
    }
    if (user.businessId) {
      this.logger.warn(
        `Usuário já possui negócio cadastrado: firebaseUid=${firebaseUid} | businessId=${user.businessId.toString()}`,
      );
      throw new ConflictException('Usuário já possui um negócio cadastrado');
    }

    const business = await this.businessModel.create({
      name: dto.name,
      logoUrl: dto.logoUrl,
      businessType: dto.businessType,
      city: dto.address?.city ?? dto.city,
      phone: dto.phone?.trim() || undefined,
      address: dto.address
        ? {
            ...dto.address,
            state: dto.address.state.toUpperCase(),
            complement: dto.address.complement?.trim() || undefined,
          }
        : undefined,
      currency: dto.currency || 'BRL',
      timezone: resolveTimeZone(dto.timezone),
    });

    await this.categoryModel.create({
      name: 'Combos',
      color: '#f59e0b',
      icon: '🎁',
      businessId: business._id,
      isSystem: true,
    });

    const updatedUser = await this.userModel
      .findByIdAndUpdate(user._id, { businessId: business._id }, { new: true })
      .populate('businessId')
      .exec();

    this.logger.log(
      `Negócio registrado: ${business._id.toString()} | "${dto.name}" | firebaseUid=${firebaseUid}`,
    );
    return { user: updatedUser, business };
  }

  async getProfile(firebaseUid: string) {
    this.logger.log(`Perfil obtido: ${firebaseUid}`);
    return this.userModel
      .findOne({ firebaseUid })
      .populate('businessId')
      .exec();
  }

  async setCustomClaims(firebaseUid: string, role: Role, businessId: string) {
    await admin.auth().setCustomUserClaims(firebaseUid, { role, businessId });
    this.logger.log(
      `Custom claims definidas: firebaseUid=${firebaseUid} | role=${role} | businessId=${businessId}`,
    );
  }
}
