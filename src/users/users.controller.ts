import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { InviteUserDto } from './dto/invite-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('users')
@Roles(Role.OWNER)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('me/avatar')
  @Roles(Role.OWNER, Role.GERENTE, Role.CAIXA)
  @UseInterceptors(
    FileInterceptor('avatar', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          return cb(
            new BadRequestException('Apenas imagens são permitidas'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  uploadAvatar(
    @CurrentUser() user: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.usersService.uploadAvatar(user.uid, user.businessId, file);
  }

  @Get()
  @Roles(Role.OWNER, Role.GERENTE)
  listUsers(@CurrentUser() user: any) {
    return this.usersService.listUsers(user.businessId);
  }

  @Post('invite')
  inviteUser(@CurrentUser() user: any, @Body() dto: InviteUserDto) {
    return this.usersService.inviteUser(user.businessId, dto);
  }

  @Patch(':id')
  updateUser(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.updateUser(user.businessId, id, user.uid, dto);
  }

  @Delete(':id')
  removeUser(@CurrentUser() user: any, @Param('id') id: string) {
    return this.usersService.removeUser(user.businessId, id);
  }

  @Patch(':id/reactivate')
  reactivateUser(@CurrentUser() user: any, @Param('id') id: string) {
    return this.usersService.reactivateUser(user.businessId, id);
  }
}
