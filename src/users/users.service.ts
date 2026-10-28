import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as admin from 'firebase-admin';
import { User, UserDocument } from './schemas/user.schema';
import { InviteUserDto } from './dto/invite-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Role } from '../common/enums/role.enum';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly storageService: StorageService,
  ) {}

  async listUsers(businessId: string): Promise<UserDocument[]> {
    return this.userModel
      .find({ businessId: new Types.ObjectId(businessId) })
      .select('-__v')
      .sort({ role: 1, displayName: 1 })
      .exec();
  }

  async inviteUser(
    businessId: string,
    dto: InviteUserDto,
  ): Promise<UserDocument> {
    const normalizedEmail = dto.email.toLowerCase();

    const existing = await this.userModel
      .findOne({
        email: normalizedEmail,
        businessId: new Types.ObjectId(businessId),
      })
      .exec();

    if (existing) {
      throw new ConflictException(
        'Já existe um usuário com esse e-mail neste negócio',
      );
    }

    const user = await this.userModel.create({
      email: normalizedEmail,
      displayName: dto.displayName,
      role: dto.role,
      businessId: new Types.ObjectId(businessId),
      isActive: false,
      isPending: true,
    });

    this.logger.log(
      `Convite criado: email=${normalizedEmail} | role=${dto.role} | negócio=${businessId}`,
    );
    return user;
  }

  async updateUser(
    businessId: string,
    userId: string,
    requestingUid: string,
    dto: UpdateUserDto,
  ): Promise<UserDocument> {
    const target = await this.userModel
      .findOne({ _id: userId, businessId: new Types.ObjectId(businessId) })
      .exec();

    if (!target) throw new NotFoundException('Usuário não encontrado');

    if (target.role === Role.OWNER) {
      throw new ForbiddenException(
        'Não é possível alterar o perfil do dono do negócio',
      );
    }

    const updated = await this.userModel
      .findByIdAndUpdate(userId, dto, { new: true })
      .exec();

    if (updated?.firebaseUid && dto.role) {
      await admin.auth().setCustomUserClaims(updated.firebaseUid, {
        role: updated.role,
        businessId,
      });
      this.logger.log(
        `Claims atualizadas: firebaseUid=${updated.firebaseUid} | role=${updated.role}`,
      );
    }

    this.logger.log(`Usuário atualizado: ${userId} | negócio=${businessId}`);
    return updated!;
  }

  async removeUser(businessId: string, userId: string): Promise<void> {
    const target = await this.userModel
      .findOne({ _id: userId, businessId: new Types.ObjectId(businessId) })
      .exec();

    if (!target) throw new NotFoundException('Usuário não encontrado');

    if (target.role === Role.OWNER) {
      throw new ForbiddenException('Não é possível remover o dono do negócio');
    }

    await this.userModel.findByIdAndUpdate(userId, { isActive: false }).exec();

    this.logger.log(`Usuário desativado: ${userId} | negócio=${businessId}`);
  }

  async uploadAvatar(
    uid: string,
    businessId: string,
    file: Express.Multer.File,
  ): Promise<UserDocument> {
    const user = await this.userModel.findOne({ firebaseUid: uid }).exec();
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const photoURL = await this.storageService.uploadUserAvatar(
      businessId,
      user._id.toString(),
      file,
    );

    await admin.auth().updateUser(uid, { photoURL });

    const updated = await this.userModel
      .findByIdAndUpdate(user._id, { photoURL }, { new: true })
      .exec();

    this.logger.log(`Avatar atualizado: firebaseUid=${uid}`);
    return updated!;
  }

  async reactivateUser(
    businessId: string,
    userId: string,
  ): Promise<UserDocument> {
    const target = await this.userModel
      .findOne({ _id: userId, businessId: new Types.ObjectId(businessId) })
      .exec();

    if (!target) throw new NotFoundException('Usuário não encontrado');
    if (!target.firebaseUid && !target.isPending) {
      throw new BadRequestException('Usuário em estado inválido');
    }

    const updated = await this.userModel
      .findByIdAndUpdate(userId, { isActive: true }, { new: true })
      .exec();

    this.logger.log(`Usuário reativado: ${userId} | negócio=${businessId}`);
    return updated!;
  }
}
