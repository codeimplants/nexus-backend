import { IsBoolean, IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { ROLE_MESSAGE, UserRole } from './create-user.dto';

export class UpdateUserDto {
    @IsOptional()
    @Matches(/^[6-9]\d{9}$/, { message: 'Phone must be a 10-digit mobile number' })
    phone?: string;

    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @IsEnum(UserRole, { message: ROLE_MESSAGE })
    role?: UserRole;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}
