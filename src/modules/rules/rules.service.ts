import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface AccessContext {
    userId: string;
    role: string;
}

@Injectable()
export class RulesService {
    constructor(private prisma: PrismaService) { }

    create(data: any) {
        return this.prisma.versionRule.create({ data });
    }

    async findAll(ctx?: AccessContext) {
        let where: { appId?: { in: string[] } } = {};
        if (ctx && (ctx.role !== 'ADMIN' && ctx.role !== 'SUPER_ADMIN')) {
            const rows = await this.prisma.appCollaborator.findMany({
                where: { adminId: ctx.userId },
                select: { appId: true },
            });
            const appIds = rows.map((r) => r.appId);
            if (appIds.length === 0) return [];
            where = { appId: { in: appIds } };
        }
        return this.prisma.versionRule.findMany({
            where,
            include: { app: true },
        });
    }

    async findOne(id: string) {
        const rule = await this.prisma.versionRule.findUnique({
            where: { id },
            include: { app: true },
        });
        if (!rule) throw new NotFoundException('Rule not found');
        return rule;
    }

    async update(id: string, data: any) {
        return this.prisma.versionRule.update({
            where: { id },
            data,
        });
    }

    async remove(id: string) {
        return this.prisma.versionRule.delete({
            where: { id },
        });
    }

    async toggle(id: string) {
        const rule = await this.findOne(id);
        return this.prisma.versionRule.update({
            where: { id },
            data: { isActive: !rule.isActive },
        });
    }
}