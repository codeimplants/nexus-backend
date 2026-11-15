import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface AuditQuery {
    adminId?: string;
    entity?: string;
    /** Only money / subscription changes (payload.sensitive). */
    sensitive?: boolean;
    from?: Date;
    to?: Date;
    take?: number;
    skip?: number;
}

/** Read side of the audit trail. Writes come from AuditInterceptor; there is no update or delete. */
@Injectable()
export class AuditService {
    constructor(private prisma: PrismaService) { }

    async find(q: AuditQuery) {
        const where: Prisma.AuditLogWhereInput = {
            ...(q.adminId ? { adminId: q.adminId } : {}),
            ...(q.entity ? { entity: { contains: q.entity } } : {}),
            ...(q.sensitive ? { payload: { path: ['sensitive'], equals: true } } : {}),
            ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
        };
        const take = Math.min(Math.max(q.take ?? 100, 1), 500);
        const [items, total] = await Promise.all([
            this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: q.skip ?? 0 }),
            this.prisma.auditLog.count({ where }),
        ]);
        return { items, total, take, skip: q.skip ?? 0 };
    }
}
