import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { Role } from '../../common/enums/role.enum';

export class UpdateUserDto {
  @IsEnum([Role.GERENTE, Role.CAIXA], {
    message: 'Perfil deve ser GERENTE ou CAIXA',
  })
  @IsOptional()
  role?: Role;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
