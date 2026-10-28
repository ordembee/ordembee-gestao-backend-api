import { IsEmail, IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { Role } from '../../common/enums/role.enum';

export class InviteUserDto {
  @IsEmail()
  email: string;

  @IsEnum([Role.GERENTE, Role.CAIXA], {
    message: 'Perfil deve ser GERENTE ou CAIXA',
  })
  role: Role;

  @IsString()
  @IsNotEmpty()
  displayName: string;
}
