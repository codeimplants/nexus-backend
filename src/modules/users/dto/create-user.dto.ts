import { IsEmail, IsEnum, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Roles the super admin can hand out. SUPER_ADMIN itself is deliberately not
 * here: it is set on one account by scripts/set-console-roles.ts, never via API.
 * Every role below is read-only (see JwtGuard).
 */
export enum UserRole {
    ADMIN = 'ADMIN',
    COLLABORATOR = 'COLLABORATOR',
    // Read-only lead-generation team: sees stats/leads for assigned apps only.
    LEAD_GEN = 'LEAD_GEN',
}

export const ROLE_MESSAGE = 'Role must be ADMIN, COLLABORATOR or LEAD_GEN';

export class CreateUserDto {
    /** 10-digit Indian mobile, the login identity (OTP is sent here). */
    @Matches(/^[6-9]\d{9}$/, { message: 'Phone must be a 10-digit mobile number' })
    phone: string;

    @IsOptional()
    @IsEmail()
    email?: string;

    @IsOptional()
    @IsString()
    name?: string;

    @IsEnum(UserRole, { message: ROLE_MESSAGE })
    role: UserRole;
}
