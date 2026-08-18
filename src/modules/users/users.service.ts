import {
    Injectable,
    NotFoundException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import * as bcrypt from 'bcryptjs';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const SALT_ROUNDS = 12;

@Injectable()
export class UsersService {
    constructor(private prisma: PrismaService) { }

    private excludePassword<T extends { password?: string }>(user: T): Omit<T, 'password'> {
        const { password: _, ...rest } = user;
        return rest;
    }

    async findAll() {
        const users = await this.prisma.admin.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                isActive: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        return users;
    }

    async findOne(id: string) {
        const user = await this.prisma.admin.findUnique({
            where: { id },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                isActive: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        if (!user) throw new NotFoundException('User not found');
        return user;
    }

    async create(dto: CreateUserDto) {
        const existing = await this.prisma.admin.findUnique({
            where: { email: dto.email.toLowerCase().trim() },
        });
        if (existing) throw new ConflictException('User with this email already exists');

        if (dto.role !== 'ADMIN' && dto.role !== 'COLLABORATOR') {
            throw new BadRequestException('Role must be ADMIN or COLLABORATOR');
        }

        const hashedPassword = await bcrypt.hash(dto.password, SALT_ROUNDS);
        const user = await this.prisma.admin.create({
            data: {
                email: dto.email.toLowerCase().trim(),
                password: hashedPassword,
                name: dto.name?.trim() || null,
                role: dto.role,
            },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                isActive: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        return user;
    }

    async update(id: string, dto: UpdateUserDto) {
        const user = await this.prisma.admin.findUnique({ where: { id } });
        if (!user) throw new NotFoundException('User not found');

        const data: { name?: string; role?: string; isActive?: boolean; password?: string } = {};
        if (dto.name !== undefined) data.name = dto.name.trim() || undefined;
        if (dto.role !== undefined) {
            if (dto.role !== 'ADMIN' && dto.role !== 'COLLABORATOR') {
                throw new BadRequestException('Role must be ADMIN or COLLABORATOR');
            }
            data.role = dto.role;
        }
        if (dto.isActive !== undefined) data.isActive = dto.isActive;
        if (dto.password !== undefined && dto.password.length > 0) {
            data.password = await bcrypt.hash(dto.password, SALT_ROUNDS);
        }

        const updated = await this.prisma.admin.update({
            where: { id },
            data,
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                isActive: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        return updated;
    }

    async remove(id: string) {
        const user = await this.prisma.admin.findUnique({ where: { id } });
        if (!user) throw new NotFoundException('User not found');
        if (user.role === 'ADMIN') {
            throw new BadRequestException('Admin users cannot be deleted. Deactivate them instead.');
        }
        await this.prisma.admin.delete({ where: { id } });
        return { success: true };
    }

    async deactivate(id: string) {
        const user = await this.prisma.admin.findUnique({ where: { id } });
        if (!user) throw new NotFoundException('User not found');
        return this.prisma.admin.update({
            where: { id },
            data: { isActive: false },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                isActive: true,
            },
        });
    }

    async updateSelf(id: string, dto: { name?: string; password?: string }) {
        const user = await this.prisma.admin.findUnique({ where: { id } });
        if (!user) throw new NotFoundException('User not found');

        const data: { name?: string; password?: string } = {};
        if (dto.name !== undefined) data.name = dto.name.trim() || undefined;
        if (dto.password !== undefined && dto.password.length > 0) {
            data.password = await bcrypt.hash(dto.password, SALT_ROUNDS);
        }

        const updated = await this.prisma.admin.update({
            where: { id },
            data,
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                isActive: true,
            },
        });
        return updated;
    }
}
