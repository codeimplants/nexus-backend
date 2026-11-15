import {
    Injectable,
    NotFoundException,
    ConflictException,
    ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const SALT_ROUNDS = 12;

const USER_SELECT = {
    id: true,
    email: true,
    phone: true,
    name: true,
    role: true,
    isActive: true,
    mfaEnabledAt: true,
    createdAt: true,
    updatedAt: true,
} as const;

/**
 * Login is phone + OTP only, but Admin.password is still a required column.
 * Store a hash of random bytes nobody knows, so the column can never be used
 * to sign in even if password login were ever switched back on.
 */
const unusablePassword = () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), SALT_ROUNDS);

/** Admin.email is required and unique; phone-only accounts get a placeholder. */
const placeholderEmail = (phone: string) => `${phone}@phone.nexus.local`;

@Injectable()
export class UsersService {
    constructor(private prisma: PrismaService) { }

    findAll() {
        return this.prisma.admin.findMany({ orderBy: { createdAt: 'desc' }, select: USER_SELECT });
    }

    async findOne(id: string) {
        const user = await this.prisma.admin.findUnique({ where: { id }, select: USER_SELECT });
        if (!user) throw new NotFoundException('User not found');
        return user;
    }

    /** The super admin account is managed by script only, never through the API. */
    private async requireEditable(id: string) {
        const user = await this.prisma.admin.findUnique({ where: { id } });
        if (!user) throw new NotFoundException('User not found');
        if (user.role === 'SUPER_ADMIN') {
            throw new ForbiddenException('The super admin account cannot be changed here');
        }
        return user;
    }

    private async assertPhoneFree(phone: string, exceptId?: string) {
        const owner = await this.prisma.admin.findUnique({ where: { phone } });
        if (owner && owner.id !== exceptId) throw new ConflictException('This phone number is already registered');
    }

    async create(dto: CreateUserDto) {
        await this.assertPhoneFree(dto.phone);
        const email = (dto.email ?? placeholderEmail(dto.phone)).toLowerCase().trim();
        if (await this.prisma.admin.findUnique({ where: { email } })) {
            throw new ConflictException('User with this email already exists');
        }

        return this.prisma.admin.create({
            data: {
                phone: dto.phone,
                email,
                password: await unusablePassword(),
                name: dto.name?.trim() || null,
                role: dto.role,
            },
            select: USER_SELECT,
        });
    }

    async update(id: string, dto: UpdateUserDto) {
        await this.requireEditable(id);
        if (dto.phone !== undefined) await this.assertPhoneFree(dto.phone, id);

        const data: { name?: string; role?: string; isActive?: boolean; phone?: string } = {};
        if (dto.name !== undefined) data.name = dto.name.trim() || undefined;
        if (dto.role !== undefined) data.role = dto.role;
        if (dto.isActive !== undefined) data.isActive = dto.isActive;
        if (dto.phone !== undefined) data.phone = dto.phone;

        return this.prisma.admin.update({ where: { id }, data, select: USER_SELECT });
    }

    async remove(id: string) {
        await this.requireEditable(id);
        await this.prisma.admin.delete({ where: { id } });
        return { success: true };
    }

    async deactivate(id: string) {
        await this.requireEditable(id);
        return this.prisma.admin.update({ where: { id }, data: { isActive: false }, select: USER_SELECT });
    }

    async resetMfa(id: string) {
        await this.requireEditable(id);
        await this.prisma.admin.update({
            where: { id },
            data: { mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null },
        });
        return { success: true };
    }

    /** Own profile: name only. Passwords no longer exist as a way in. */
    async updateSelf(id: string, dto: { name?: string }) {
        const user = await this.prisma.admin.findUnique({ where: { id } });
        if (!user) throw new NotFoundException('User not found');
        const data: { name?: string } = {};
        if (dto.name !== undefined) data.name = dto.name.trim() || undefined;
        return this.prisma.admin.update({ where: { id }, data, select: USER_SELECT });
    }
}
